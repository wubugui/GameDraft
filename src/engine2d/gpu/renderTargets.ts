import type { Texture } from '../textures/Texture';
import type { TextureSource } from '../textures/TextureSource';

/** 能当渲染目标的东西:纹理(RenderTexture 或池里的临时纹理)、它的源,或画布 */
export type RenderSurface = Texture | TextureSource | HTMLCanvasElement | OffscreenCanvas;
