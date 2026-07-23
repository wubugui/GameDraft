import { Texture, type TextureSource } from 'pixi.js';
import type { AssetManager } from './AssetManager';
import type { SceneDepthConfig, IGameSystem, GameContext, RgbColor } from '../data/types';
import { DepthOcclusionFilter } from '../rendering/DepthOcclusionFilter';
import {
  EntityLightingFilter,
  type IEntityShadingFilter,
} from '../rendering/EntityLightingFilter';
import {
  CharacterShadingFilter,
  type CharShadingSceneResources,
} from '../rendering/CharacterShadingFilter';
import type { ResolvedLightEnv } from '../rendering/lightEnv';
import type { ShadowSceneContext, IEntityShadow } from '../rendering/entityShadowTypes';
import { depthLog, depthError } from './depthLog';
import { sceneRuntimeAssetUrl } from './projectPaths';
import { sampleGroundFieldWorld, type GroundDepthField } from '../utils/groundDepthField';

const T = 'DepthSystem';

/** 实验室 CHAR_FS 的遮挡偏置常数（`dFront < uFootQ.z - .045`）：
 *  脚点深度直接取自行走面场，残差≈0，这点余量用来吃掉采样/量化噪声。 */
const LAB_OCCLUSION_BIAS = 0.045;

export class SceneDepthSystem implements IGameSystem {
    private enabled = false;
    private config: SceneDepthConfig | null = null;
    private depthTexture: Texture | null = null;
    private collisionData: Uint8Array | null = null;
    private collisionTexture: Texture | null = null;
    private collisionW = 0;
    private collisionH = 0;
    private filters: IEntityShadingFilter[] = [];
    /** 持有显式 occlusionBlendFactor 覆盖的滤镜：F2 全局遮挡混合广播跳过它们
     *  （单一所有者：实体作者值不被场景级调试滑块静默盖掉） */
    private blendOverriddenFilters = new Set<IEntityShadingFilter>();
    /** 已建阴影实例（由 Game 在创建/销毁时注册/注销）：深度调参 setter 广播到此，避免只有滤镜生效而阴影读旧值 */
    private shadows = new Set<IEntityShadow>();

    /** 逐 entity 光照（阴影/色调/AO）：与深度遮挡解耦，可在无 depthConfig 的场景独立启用 */
    private lightingEnabled = false;
    private probeSource: TextureSource | null = null;
    private lightEnv: ResolvedLightEnv | null = null;

    private _depthTolerance = 0;
    private _floorOffset = 0;
    /** F2 可改；默认半透明混合（非硬裁切），与地图预乘合成 */
    private _occlusionBlendFactor = 0.28;
    /** 实验室口径的脚点遮挡偏置（F2 可改） */
    private _footBias = LAB_OCCLUSION_BIAS;

    /** 行走面深度场（照明载荷带来，Game 在就绪/卸载时注入）：遮挡脚点、碰撞反投影、
     *  影子落地面的**唯一**地面真值。为 null 时这三者一律**不做**（遮挡关、碰撞恒 false、
     *  影子不裁切）——floor_depth_A/B 直线口径已彻底废除，绝不静默顶上。 */
    private groundField: GroundDepthField | null = null;
    /** 行走面场的 GPU 版(影子逐像素取地面用);与 groundField 同源,由 Game 一并注入 */
    private groundTex: { tex: TextureSource; min: number; max: number } | null = null;

    private R00 = 0; private R01 = 0; private R02 = 0;
    private R10 = 0; private R11 = 0; private R12 = 0;
    private R20 = 0; private R21 = 0; private R22 = 0;
    private ppu = 1; private cx = 0; private cy = 0;
    private colXMin = 0; private colZMin = 0; private colCellSize = 1;
    private colHeightOffset = 0;

    private sceneW = 0;
    private sceneH = 0;
    private sceneId = '';

    /** 世界坐标 → 像素坐标 的转换比例 */
    private worldToPixelX = 1;
    private worldToPixelY = 1;

    get depthTolerance(): number { return this._depthTolerance; }
    set depthTolerance(v: number) {
        this._depthTolerance = v;
        for (const f of this.filters) f.setTolerance(v);
        this.broadcastDepthParamsToShadows();
    }

    get floorOffset(): number { return this._floorOffset; }
    set floorOffset(v: number) {
        this._floorOffset = v;
        for (const f of this.filters) f.setFloorOffset(v);
        this.broadcastDepthParamsToShadows();
    }

    /** 场景级深度遮挡半透明混合系数（F2 调试 / 实体缺省来源）：遮挡像素 alpha *= factor，0 为硬裁切。
     *  持有显式实体级覆盖的滤镜不受此广播影响。 */
    get occlusionBlendFactor(): number { return this._occlusionBlendFactor; }
    set occlusionBlendFactor(v: number) {
        const c = Math.min(1, Math.max(0, Number(v) || 0));
        this._occlusionBlendFactor = c;
        for (const f of this.filters) {
            if (!this.blendOverriddenFilters.has(f)) f.setOcclusionBlendFactor(c);
        }
        this.broadcastDepthParamsToShadows();
    }

    /** 脚点遮挡偏置（实验室 0.045；仅在有行走面场时生效） */
    get footBias(): number { return this._footBias; }
    set footBias(v: number) {
        this._footBias = Math.max(0, Number(v) || 0);
        for (const f of this.filters) f.setFootBias?.(this._footBias);
    }

    /**
     * 注入/清除行走面深度场。单一所有者：场由 CharacterLightingSystem 载入并持有，
     * 本系统只借用只读引用；载荷卸载时 Game 必须传 null（律5 生命周期对称）。
     */
    setGroundDepthField(
        field: GroundDepthField | null,
        tex: { tex: TextureSource; min: number; max: number } | null = null,
    ): void {
        this.groundField = field;
        this.groundTex = tex;
        depthLog(T, 'groundDepthField', field ? `${field.w}x${field.h}` : 'cleared');
    }

    get hasGroundDepthField(): boolean { return this.groundField !== null; }

    /** 场景世界坐标处的行走面深度；无场返回 null（调用方回落旧直线口径） */
    sampleGroundDepth(worldX: number, worldY: number): number | null {
        const f = this.groundField;
        if (!f) return null;
        return sampleGroundFieldWorld(f, this.sceneW, this.sceneH, worldX, worldY);
    }

    /** 解析实体级遮挡混合系数：有限数则钳到 [0,1] 作为覆盖，否则回落场景默认（不覆盖） */
    private resolveEntityBlend(override: number | undefined): { value: number; overridden: boolean } {
        if (typeof override === 'number' && Number.isFinite(override)) {
            return { value: Math.min(1, Math.max(0, override)), overridden: true };
        }
        return { value: this._occlusionBlendFactor, overridden: false };
    }

    /** 注册阴影实例进调参广播列表；注册即同步一次当前值（阴影构造时烘焙的是快照） */
    registerShadow(sh: IEntityShadow): void {
        this.shadows.add(sh);
        sh.setDepthParams?.(this._depthTolerance, this._floorOffset, this._occlusionBlendFactor);
    }

    unregisterShadow(sh: IEntityShadow): void {
        this.shadows.delete(sh);
    }

    private broadcastDepthParamsToShadows(): void {
        for (const sh of this.shadows) {
            sh.setDepthParams?.(this._depthTolerance, this._floorOffset, this._occlusionBlendFactor);
        }
    }

    init(_ctx: GameContext): void {}
    update(_dt: number): void {}
    serialize(): object { return {}; }
    deserialize(_data: object): void {}

    get isEnabled(): boolean { return this.enabled; }
    /** 深度遮挡或光照任一启用：决定是否创建逐 entity 滤镜并逐帧驱动 */
    get isActive(): boolean { return this.enabled || this.lightingEnabled; }
    get isLightingEnabled(): boolean { return this.lightingEnabled; }
    get currentLightEnv(): ResolvedLightEnv | null { return this.lightEnv; }
    get currentConfig(): SceneDepthConfig | null { return this.config; }
    get currentDepthTexture(): Texture | null { return this.depthTexture; }
    get currentSceneId(): string { return this.sceneId; }

    async load(
        sceneId: string,
        depthConfig: SceneDepthConfig,
        assetManager: AssetManager,
        sceneW: number,
        sceneH: number,
        worldToPixelX: number,
        worldToPixelY: number,
    ): Promise<void> {
        depthLog(T, 'load() scene:', sceneId, 'size:', sceneW, 'x', sceneH);
        depthLog(T, 'depthConfig:', depthConfig);

        this.unload();
        this.config = depthConfig;
        this.enabled = true;
        this.sceneId = sceneId;
        this.sceneW = sceneW;
        this.sceneH = sceneH;
        this.worldToPixelX = worldToPixelX;
        this.worldToPixelY = worldToPixelY;

        try {
            const p = sceneRuntimeAssetUrl(sceneId, depthConfig.depth_map);
            depthLog(T, 'loading depth texture:', p);
            this.depthTexture = await assetManager.loadTexture(p);
            depthLog(T, 'depth texture OK:', this.depthTexture.width, 'x', this.depthTexture.height);
        } catch (e) {
            depthError(T, 'depth texture FAILED', e);
            this.enabled = false;
            return;
        }

        if (depthConfig.collision_map) {
            try {
                const cp = sceneRuntimeAssetUrl(sceneId, depthConfig.collision_map);
                depthLog(T, 'loading collision:', cp);
                await this.loadCollisionBitmap(cp, assetManager);
                depthLog(T, 'collision OK:', this.collisionW, 'x', this.collisionH, 'non-zero:', this.collisionData ? Array.from(this.collisionData.slice(0, 20)).filter(v => v > 0).length : 0);
                // GPU 纹理：供 planar 阴影 shader 做碰撞裁切（PNG 直接得 GPU Texture）
                try { this.collisionTexture = await assetManager.loadTexture(cp); } catch { this.collisionTexture = null; }
            } catch (e) {
                depthError(T, 'collision FAILED', e);
            }
        }

        const M = depthConfig.M;
        this.R00 = M.R[0][0]; this.R01 = M.R[0][1]; this.R02 = M.R[0][2];
        this.R10 = M.R[1][0]; this.R11 = M.R[1][1]; this.R12 = M.R[1][2];
        this.R20 = M.R[2][0]; this.R21 = M.R[2][1]; this.R22 = M.R[2][2];
        this.ppu = M.ppu; this.cx = M.cx; this.cy = M.cy;

        const col = depthConfig.collision;
        if (col) {
            this.colXMin = col.x_min; this.colZMin = col.z_min;
            this.colCellSize = col.cell_size;
            this.collisionW = col.grid_width; this.collisionH = col.grid_height;
            this.colHeightOffset = col.height_offset;
            depthLog(T, 'collision grid:', col);
        }

        this._depthTolerance = depthConfig.depth_tolerance;
        this._floorOffset = depthConfig.floor_offset;

        depthLog(T, 'load() done. enabled:', this.enabled, 'depthTex:', !!this.depthTexture, 'collisionData:', !!this.collisionData);
    }

    /** 调试：场景 world 尺寸在运行时被修改后，同步深度/光照滤镜与碰撞采样比例（不重载纹理） */
    applyRuntimeSceneSize(sceneW: number, sceneH: number, worldToPixelX: number, worldToPixelY: number): void {
        // 光照-only 场景（无 depth 但 lighting 开）也需更新，否则 probe UV 采样错位
        if (!this.isActive) return;
        this.sceneW = sceneW;
        this.sceneH = sceneH;
        this.worldToPixelX = worldToPixelX;
        this.worldToPixelY = worldToPixelY;
        for (const f of this.filters) {
            f.setSceneSize(sceneW, sceneH);
            f.setWorldToPixel(worldToPixelX, worldToPixelY);
        }
    }

    loadDefault(): void {
        depthLog(T, 'loadDefault - disabled');
        this.unload();
        this.enabled = false;
    }

    unload(): void {
        this.depthTexture = null;
        this.collisionData = null;
        this.collisionTexture = null;
        this.collisionW = 0; this.collisionH = 0;
        this.config = null;
        this.enabled = false;
        this.filters = [];
        this.blendOverriddenFilters.clear();
        // 阴影实例由 Game 负责注销；此处兜底清空，防跨场景残留引用
        this.shadows.clear();
        this.worldToPixelX = 1;
        this.worldToPixelY = 1;
        this.lightingEnabled = false;
        this.probeSource = null;
        this.lightEnv = null;
        // 场归 CharacterLightingSystem 所有，这里只断引用（防跨场景采到上一张图的地面）
        this.groundField = null;
        this.groundTex = null;
    }

    /**
     * 启用逐 entity 光照。可在有/无 depthConfig 时调用：
     * - 有 depth：光照滤镜同时做遮挡（替代 DepthOcclusionFilter）。
     * - 无 depth：仅做色调融入 + AO，仍需场景尺寸用于 probe 采样坐标。
     */
    enableLighting(
        probeSource: TextureSource | null,
        lightEnv: ResolvedLightEnv,
        sceneW: number,
        sceneH: number,
        worldToPixelX: number,
        worldToPixelY: number,
    ): void {
        this.lightingEnabled = true;
        this.probeSource = probeSource;
        this.lightEnv = lightEnv;
        this.sceneW = sceneW;
        this.sceneH = sceneH;
        // depth 关时这两个值仅供光照滤镜的世界重建/采样使用；depth 开时 load() 已设过相同值
        this.worldToPixelX = worldToPixelX;
        this.worldToPixelY = worldToPixelY;
    }

    disableLighting(): void {
        this.lightingEnabled = false;
        this.probeSource = null;
        this.lightEnv = null;
    }

    /**
     * 阴影系统上下文（深度图GPU + 碰撞图GPU + 完整9元M + 网格/floor/深度映射参数）。
     * planar 与 real(deferred) 阴影共用,各取所需。无 depthConfig/深度纹理时返回 null。
     */
    getShadowSceneContext(): ShadowSceneContext | null {
        if (!this.enabled || !this.depthTexture || !this.config) return null;
        const dm = this.config.depth_mapping;
        return {
            depthTexture: this.depthTexture,
            collisionTexture: this.collisionTexture,
            sceneW: this.sceneW,
            sceneH: this.sceneH,
            worldToPixelX: this.worldToPixelX,
            worldToPixelY: this.worldToPixelY,
            invert: dm.invert ? 1 : 0,
            scale: dm.scale,
            offset: dm.offset,
            floorOffset: this._floorOffset,
            groundTexture: this.groundTex?.tex ?? null,
            groundMin: this.groundTex?.min ?? 0,
            groundMax: this.groundTex?.max ?? 1,
            tolerance: this._depthTolerance,
            occlusionBlendFactor: this._occlusionBlendFactor,
            ppu: this.ppu,
            cx: this.cx,
            cy: this.cy,
            r00: this.R00, r01: this.R01, r02: this.R02,
            r10: this.R10, r11: this.R11, r12: this.R12,
            r20: this.R20, r21: this.R21, r22: this.R22,
            colXMin: this.colXMin,
            colZMin: this.colZMin,
            colCellSize: this.colCellSize,
            colGridW: this.collisionW,
            colGridH: this.collisionH,
        };
    }

    private async loadCollisionBitmap(path: string, assetManager: AssetManager): Promise<void> {
        const bitmap = await assetManager.loadBitmap(path);

        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        const imgData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

        this.collisionData = new Uint8Array(bitmap.width * bitmap.height);
        for (let i = 0; i < this.collisionData.length; i++) {
            this.collisionData[i] = imgData.data[i * 4];
        }
        this.collisionW = bitmap.width;
        this.collisionH = bitmap.height;
    }

    /**
     * 碰撞检测
     * @param worldX 世界坐标 X
     * @param worldY 世界坐标 Y
     */
    isCollision(worldX: number, worldY: number): boolean {
        if (!this.enabled || !this.collisionData) return false;

        // 世界坐标 → 像素坐标
        const sx = worldX * this.worldToPixelX;
        const sy = worldY * this.worldToPixelY;

        // 像素坐标 → 伪3D空间 → 碰撞网格。地面深度只认行走面场——floor 拟合直线在
        // 多层街巷可偏出 200+ 行地面，会把碰撞读到错误的格子上，已废除。
        const dFloor = this.sampleGroundDepth(worldX, worldY);
        if (dFloor === null) return false;
        const px = (sx - this.cx) / this.ppu;
        const py = (this.cy - sy) / this.ppu;

        const wx = this.R00 * px + this.R01 * py + this.R02 * dFloor;
        const wz = this.R20 * px + this.R21 * py + this.R22 * dFloor;

        const gx = Math.floor((wx - this.colXMin) / this.colCellSize);
        const gz = Math.floor((wz - this.colZMin) / this.colCellSize);

        if (gx < 0 || gx >= this.collisionW || gz < 0 || gz >= this.collisionH) return false;
        return this.collisionData[gz * this.collisionW + gx] > 127;
    }

    createFilterForEntity(occlusionBlendOverride?: number): DepthOcclusionFilter | null {
        depthLog(T, 'createFilter: enabled=', this.enabled, 'depthTex=', !!this.depthTexture, 'config=', !!this.config);
        if (!this.enabled || !this.depthTexture || !this.config) return null;
        try {
            const f = DepthOcclusionFilter.createForEntity(this.depthTexture, this.config);
            f.setSceneSize(this.sceneW, this.sceneH);
            f.setWorldToPixel(this.worldToPixelX, this.worldToPixelY);
            const blend = this.resolveEntityBlend(occlusionBlendOverride);
            f.setOcclusionBlendFactor(blend.value);
            if (blend.overridden) this.blendOverriddenFilters.add(f);
            f.setFootBias(this._footBias);
            this.filters.push(f);
            depthLog(T, 'filter created, sceneSize (rendered):', this.sceneW, 'x', this.sceneH, 'total:', this.filters.length);
            return f;
        } catch (e) {
            depthError(T, 'createFilter FAILED', e);
            return null;
        }
    }

    /**
     * 为实体创建「光照滤镜」（色调融入 + AO + 可选遮挡）。
     * 仅在 lightingEnabled 时返回；depth 同时启用则一并做遮挡（替代独立的 DepthOcclusionFilter）。
     * @param sampleLiftWorld 在脚部之上多少世界单位处采样 probe（≈0.4×角色高度）
     */
    createLightingFilterForEntity(sampleLiftWorld: number, occlusionBlendOverride?: number): IEntityShadingFilter | null {
        if (!this.lightingEnabled || !this.lightEnv) return null;
        try {
            const f = EntityLightingFilter.createForEntity({
                depthTexture: this.enabled ? this.depthTexture : null,
                cfg: this.enabled ? this.config : null,
                probeSource: this.probeSource,
                lightEnv: this.lightEnv,
                sampleLiftWorld,
            });
            f.setSceneSize(this.sceneW, this.sceneH);
            f.setWorldToPixel(this.worldToPixelX, this.worldToPixelY);
            // 遮挡仅在 depth 启用时发生；lighting-only 场景无遮挡，覆盖无意义故不登记
            if (this.enabled) {
                const blend = this.resolveEntityBlend(occlusionBlendOverride);
                f.setOcclusionBlendFactor(blend.value);
                if (blend.overridden) this.blendOverriddenFilters.add(f);
            }
            f.setFootBias(this._footBias);
            this.filters.push(f);
            return f;
        } catch (e) {
            depthError(T, 'createLightingFilter FAILED', e);
            return null;
        }
    }

    /**
     * 为实体创建「烘焙着色滤镜」(实验室 CHAR_FS 移植:albedo×E 逐像素物理着色)。
     * 资源由 CharacterLightingSystem 载入;此处只负责组装遮挡上下文与注册驱动列表
     * (与 createLightingFilterForEntity 同型)。游戏侧 AO 经 applyShadowFilterToneAO
     * 广播命中 setAO;tone 无 setter=淘汰,不会被旧曲线写入。
     */
    createBakedFilterForEntity(
        scene: CharShadingSceneResources,
        occlusionBlendOverride?: number,
    ): CharacterShadingFilter | null {
        try {
            const f = CharacterShadingFilter.createForEntity({
                depthTexture: this.enabled ? this.depthTexture : null,
                cfg: this.enabled ? this.config : null,
                scene,
            });
            f.setSceneSize(this.sceneW, this.sceneH);
            f.setWorldToPixel(this.worldToPixelX, this.worldToPixelY);
            if (this.enabled) {
                const blend = this.resolveEntityBlend(occlusionBlendOverride);
                f.setOcclusionBlendFactor(blend.value);
                if (blend.overridden) this.blendOverriddenFilters.add(f);
            }
            f.setFootBias(this._footBias);
            this.filters.push(f);
            return f;
        } catch (e) {
            depthError(T, 'createBakedFilter FAILED', e);
            return null;
        }
    }

    /** 实体销毁时摘除，避免 updatePerFrame 仍引用已 destroy 的滤镜 */
    removeFilter(f: IEntityShadingFilter): void {
        const i = this.filters.indexOf(f);
        if (i >= 0) this.filters.splice(i, 1);
        this.blendOverriddenFilters.delete(f);
    }

    setDebugOnFilters(on: boolean): void {
        for (const f of this.filters) f.setDebug(on);
    }

    /** 按当前模式/toneEnabled 设置所有光照滤镜的 tone 与 sprite-AO（DepthOcclusionFilter 无这两 setter，跳过） */
    applyShadowFilterToneAO(tone: number, aoContact: number, aoForm: number): void {
        for (const f of this.filters) {
            f.setTone?.(tone);
            f.setAO?.(aoContact, aoForm);
        }
    }

    /** 把 key/ambient 颜色与强度广播到所有光照滤镜（供光环境曲线逐帧动画；构造时已设，此处覆盖） */
    applyKeyAmbient(
        keyColor: RgbColor,
        keyIntensity: number,
        ambientColor: RgbColor,
        ambientIntensity: number,
    ): void {
        for (const f of this.filters) {
            f.setKeyLight?.(keyColor, keyIntensity);
            f.setAmbient?.(ambientColor, ambientIntensity);
        }
    }

    private _lastFootLogMs = -Infinity;

    updatePerFrame(worldContainerX: number, worldContainerY: number, projectionScale: number): void {
        if (!this.isActive) return;
        for (const f of this.filters) {
            f.setWorldContainerPos(worldContainerX, worldContainerY);
            f.setProjectionScale(projectionScale);
        }
    }

    /**
     * @param footWorldX 脚底中心世界 X
     * @param footWorldY 脚底世界坐标 Y（与 Player/NPC 的 y 一致）
     * @param floorOffsetExtra 按实体叠加的 floor 偏移（如 depth_floor 区）
     */
    updateEntityDepthOcclusion(
        filter: IEntityShadingFilter,
        footWorldX: number,
        footWorldY: number,
        floorOffsetExtra: number,
    ): void {
        filter.setEntityFootY(footWorldY);
        filter.setEntityFootX?.(footWorldX);
        filter.setFloorOffsetExtra(floorOffsetExtra);
        // 实验室口径:遮挡按「相机平行 billboard @ 脚点深度」判,脚深度取行走面场真值。
        // 无场时传 null → 滤镜回落旧的 floor 直线 + 倾斜面。
        filter.setFootDepthQ?.(this.sampleGroundDepth(footWorldX, footWorldY));
        // 按时间节流：按调用数取模在多实体场景下频率随实体数放大，会刷屏。
        const now = performance.now();
        if (now - this._lastFootLogMs >= 5000) {
            this._lastFootLogMs = now;
            const gd = this.sampleGroundDepth(footWorldX, footWorldY);
            depthLog(
                T,
                'foot:', footWorldX.toFixed(2), footWorldY.toFixed(2),
                'groundD:', gd === null ? '无场' : gd.toFixed(4),
            );
        }
    }

    destroy(): void {
        this.unload();
    }
}
