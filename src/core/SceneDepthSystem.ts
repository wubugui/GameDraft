import { Texture } from 'pixi.js';
import type { AssetManager } from './AssetManager';
import type { SceneDepthConfig } from '../data/types';
import { DepthOcclusionFilter } from '../rendering/DepthOcclusionFilter';
import { resolveAssetPath } from './assetPath';
import { depthLog, depthError } from './depthLog';

const T = 'DepthSystem';

export class SceneDepthSystem {
    private enabled = false;
    private config: SceneDepthConfig | null = null;
    private depthTexture: Texture | null = null;
    private collisionData: Uint8Array | null = null;
    private collisionW = 0;
    private collisionH = 0;
    private filters: DepthOcclusionFilter[] = [];

    private _depthTolerance = 0;
    private _floorOffset = 0;

    private R00 = 0; private R01 = 0; private R02 = 0;
    private R20 = 0; private R21 = 0; private R22 = 0;
    private ppu = 1; private cx = 0; private cy = 0;
    private colXMin = 0; private colZMin = 0; private colCellSize = 1;
    private colHeightOffset = 0;
    private floorA = 0; private floorB = 0;

    private sceneW = 0;
    private sceneH = 0;

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

    get isEnabled(): boolean { return this.enabled; }

    async load(sceneId: string, depthConfig: SceneDepthConfig, assetManager: AssetManager, sceneW: number, sceneH: number): Promise<void> {
        depthLog(T, 'load() scene:', sceneId, 'size:', sceneW, 'x', sceneH);
        depthLog(T, 'depthConfig:', depthConfig);

        this.unload();
        this.config = depthConfig;
        this.enabled = true;
        this.sceneW = sceneW;
        this.sceneH = sceneH;

        const basePath = `assets/scenes/${sceneId}/`;

        try {
            const p = basePath + depthConfig.depth_map;
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
                const cp = basePath + depthConfig.collision_map;
                depthLog(T, 'loading collision:', cp);
                await this.loadCollisionBitmap(cp);
                depthLog(T, 'collision OK:', this.collisionW, 'x', this.collisionH, 'non-zero:', this.collisionData ? Array.from(this.collisionData.slice(0, 20)).filter(v => v > 0).length : 0);
            } catch (e) {
                depthError(T, 'collision FAILED', e);
            }
        }

        const M = depthConfig.M;
        this.R00 = M.R[0][0]; this.R01 = M.R[0][1]; this.R02 = M.R[0][2];
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

    loadDefault(): void {
        depthLog(T, 'loadDefault - disabled');
        this.unload();
        this.enabled = false;
    }

    unload(): void {
        this.depthTexture = null;
        this.collisionData = null;
        this.collisionW = 0; this.collisionH = 0;
        this.config = null;
        this.enabled = false;
        this.filters = [];
    }

    private async loadCollisionBitmap(path: string): Promise<void> {
        const resolved = resolveAssetPath(path);
        const resp = await fetch(resolved);
        if (!resp.ok) throw new Error(`fetch ${resp.status} for ${resolved}`);
        const blob = await resp.blob();
        const bitmap = await createImageBitmap(blob);

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
        bitmap.close();
    }

    isCollision(sx: number, sy: number): boolean {
        if (!this.enabled || !this.collisionData) return false;

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
            this.filters.push(f);
            depthLog(T, 'filter created, sceneSize:', this.sceneW, 'x', this.sceneH, 'total:', this.filters.length);
            return f;
        } catch (e) {
            depthError(T, 'createFilter FAILED', e);
            return null;
        }
    }

    private _logCounter = 0;

    updatePerFrame(worldContainerX: number, worldContainerY: number): void {
        if (!this.enabled) return;
        for (const f of this.filters) f.setWorldContainerPos(worldContainerX, worldContainerY);
        if (this._logCounter % 300 === 0) {
            depthLog(T, 'perFrame wcPos:', worldContainerX.toFixed(1), worldContainerY.toFixed(1));
        }
    }

    updateEntityFootY(filter: DepthOcclusionFilter, y: number): void {
        filter.setEntityFootY(y);
        if (this._logCounter % 300 === 0) {
            const floorA = this.config?.shader.floor_depth_A ?? 0;
            const floorB = this.config?.shader.floor_depth_B ?? 0;
            const dBase = floorA * y + floorB + this._floorOffset;
            depthLog(T, 'footY:', y.toFixed(1), 'floorA:', floorA, 'floorB:', floorB.toFixed(4), 'd_base:', dBase.toFixed(4));
            this._logCounter++;
        } else {
            this._logCounter++;
        }
    }
}
