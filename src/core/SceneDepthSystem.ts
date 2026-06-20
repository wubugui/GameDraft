import { Texture, type TextureSource } from 'pixi.js';
import type { AssetManager } from './AssetManager';
import type { SceneDepthConfig, IGameSystem, GameContext } from '../data/types';
import { DepthOcclusionFilter } from '../rendering/DepthOcclusionFilter';
import {
  EntityLightingFilter,
  type IEntityShadingFilter,
} from '../rendering/EntityLightingFilter';
import type { ResolvedLightEnv } from '../rendering/lightEnv';
import type { ShadowSceneContext } from '../rendering/entityShadowTypes';
import { depthLog, depthError } from './depthLog';

const T = 'DepthSystem';

export class SceneDepthSystem implements IGameSystem {
    private enabled = false;
    private config: SceneDepthConfig | null = null;
    private depthTexture: Texture | null = null;
    private collisionData: Uint8Array | null = null;
    private collisionTexture: Texture | null = null;
    private collisionW = 0;
    private collisionH = 0;
    // 深度图 CPU 像素（RGBA），供阴影 depth-drape 逐顶点在 CPU 采样位移（顶点纹理采样在 Pixi 自定义 shader 不可靠）
    private depthPixels: Uint8ClampedArray | null = null;
    private depthPxW = 0;
    private depthPxH = 0;
    private filters: IEntityShadingFilter[] = [];

    /** 逐 entity 光照（阴影/色调/AO）：与深度遮挡解耦，可在无 depthConfig 的场景独立启用 */
    private lightingEnabled = false;
    private probeSource: TextureSource | null = null;
    private lightEnv: ResolvedLightEnv | null = null;

    private _depthTolerance = 0;
    private _floorOffset = 0;
    /** F2 可改；默认半透明混合（非硬裁切），与地图预乘合成 */
    private _occlusionBlendFactor = 0.28;

    private R00 = 0; private R01 = 0; private R02 = 0;
    private R10 = 0; private R11 = 0; private R12 = 0;
    private R20 = 0; private R21 = 0; private R22 = 0;
    private ppu = 1; private cx = 0; private cy = 0;
    private colXMin = 0; private colZMin = 0; private colCellSize = 1;
    private colHeightOffset = 0;
    private floorA = 0; private floorB = 0;

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
    }

    get floorOffset(): number { return this._floorOffset; }
    set floorOffset(v: number) {
        this._floorOffset = v;
        for (const f of this.filters) f.setFloorOffset(v);
    }

    /** 深度遮挡半透明混合系数（调试）：遮挡像素 alpha *= factor，0 为硬裁切 */
    get occlusionBlendFactor(): number { return this._occlusionBlendFactor; }
    set occlusionBlendFactor(v: number) {
        const c = Math.min(1, Math.max(0, Number(v) || 0));
        this._occlusionBlendFactor = c;
        for (const f of this.filters) f.setOcclusionBlendFactor(c);
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

        const basePath = `resources/runtime/scenes/${sceneId}/`;

        try {
            const p = basePath + depthConfig.depth_map;
            depthLog(T, 'loading depth texture:', p);
            this.depthTexture = await assetManager.loadTexture(p);
            depthLog(T, 'depth texture OK:', this.depthTexture.width, 'x', this.depthTexture.height);
            // 额外解码深度图 CPU 像素（供阴影 depth-drape）
            try {
                const bm = await assetManager.loadBitmap(p);
                const cv = new OffscreenCanvas(bm.width, bm.height);
                const c2d = cv.getContext('2d')!;
                c2d.drawImage(bm, 0, 0);
                this.depthPixels = c2d.getImageData(0, 0, bm.width, bm.height).data;
                this.depthPxW = bm.width;
                this.depthPxH = bm.height;
            } catch (e2) {
                depthError(T, 'depth pixels decode FAILED', e2);
                this.depthPixels = null;
            }
        } catch (e) {
            depthError(T, 'depth texture FAILED', e);
            this.enabled = false;
            return;
        }

        if (depthConfig.collision_map) {
            try {
                const cp = basePath + depthConfig.collision_map;
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

        this.floorA = depthConfig.shader.floor_depth_A;
        this.floorB = depthConfig.shader.floor_depth_B;
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
        this.depthPixels = null;
        this.depthPxW = 0; this.depthPxH = 0;
        this.config = null;
        this.enabled = false;
        this.filters = [];
        this.worldToPixelX = 1;
        this.worldToPixelY = 1;
        this.lightingEnabled = false;
        this.probeSource = null;
        this.lightEnv = null;
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
     * 阴影系统上下文（深度图GPU + 碰撞图GPU + 深度CPU像素 + 完整9元M + 网格/floor/深度映射参数）。
     * planar 与 real(deferred) 阴影共用,各取所需。无 depthConfig/深度纹理时返回 null。
     */
    getShadowSceneContext(): ShadowSceneContext | null {
        if (!this.enabled || !this.depthTexture || !this.config) return null;
        const dm = this.config.depth_mapping;
        return {
            depthTexture: this.depthTexture,
            collisionTexture: this.collisionTexture,
            depthPixels: this.depthPixels,
            depthPxW: this.depthPxW,
            depthPxH: this.depthPxH,
            sceneW: this.sceneW,
            sceneH: this.sceneH,
            worldToPixelX: this.worldToPixelX,
            worldToPixelY: this.worldToPixelY,
            invert: dm.invert ? 1 : 0,
            scale: dm.scale,
            offset: dm.offset,
            floorA: this.floorA,
            floorB: this.floorB,
            floorOffset: this._floorOffset,
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

        // 像素坐标 → 伪3D空间 → 碰撞网格（逻辑不变）
        const dFloor = this.floorA * sy + this.floorB;
        const px = (sx - this.cx) / this.ppu;
        const py = (this.cy - sy) / this.ppu;

        const wx = this.R00 * px + this.R01 * py + this.R02 * dFloor;
        const wz = this.R20 * px + this.R21 * py + this.R22 * dFloor;

        const gx = Math.floor((wx - this.colXMin) / this.colCellSize);
        const gz = Math.floor((wz - this.colZMin) / this.colCellSize);

        if (gx < 0 || gx >= this.collisionW || gz < 0 || gz >= this.collisionH) return false;
        return this.collisionData[gz * this.collisionW + gx] > 127;
    }

    createFilterForEntity(): DepthOcclusionFilter | null {
        depthLog(T, 'createFilter: enabled=', this.enabled, 'depthTex=', !!this.depthTexture, 'config=', !!this.config);
        if (!this.enabled || !this.depthTexture || !this.config) return null;
        try {
            const f = DepthOcclusionFilter.createForEntity(this.depthTexture, this.config);
            f.setSceneSize(this.sceneW, this.sceneH);
            f.setWorldToPixel(this.worldToPixelX, this.worldToPixelY);
            f.setOcclusionBlendFactor(this._occlusionBlendFactor);
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
    createLightingFilterForEntity(sampleLiftWorld: number): IEntityShadingFilter | null {
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
            if (this.enabled) f.setOcclusionBlendFactor(this._occlusionBlendFactor);
            this.filters.push(f);
            return f;
        } catch (e) {
            depthError(T, 'createLightingFilter FAILED', e);
            return null;
        }
    }

    /** 实体销毁时摘除，避免 updatePerFrame 仍引用已 destroy 的滤镜 */
    removeFilter(f: IEntityShadingFilter): void {
        const i = this.filters.indexOf(f);
        if (i >= 0) this.filters.splice(i, 1);
    }

    setCollisionTextureOnFilters(tex: Texture): void {
        for (const f of this.filters) f.setCollisionTexture(tex);
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

    private _logCounter = 0;

    updatePerFrame(worldContainerX: number, worldContainerY: number, projectionScale: number): void {
        if (!this.isActive) return;
        for (const f of this.filters) {
            f.setWorldContainerPos(worldContainerX, worldContainerY);
            f.setProjectionScale(projectionScale);
        }
        if (this._logCounter % 300 === 0) {
            depthLog(T, 'perFrame wcPos:', worldContainerX.toFixed(1), worldContainerY.toFixed(1));
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
        if (this._logCounter % 300 === 0) {
            const floorA = this.config?.shader.floor_depth_A ?? 0;
            const floorB = this.config?.shader.floor_depth_B ?? 0;
            const syTex = footWorldY * this.worldToPixelY;
            const dBase = floorA * syTex + floorB + this._floorOffset + floorOffsetExtra;
            depthLog(
                T,
                'foot:', footWorldX.toFixed(2), footWorldY.toFixed(2),
                'syTex:', syTex.toFixed(2), 'd_base:', dBase.toFixed(4),
            );
            this._logCounter++;
        } else {
            this._logCounter++;
        }
    }

    destroy(): void {
        this.unload();
    }
}
