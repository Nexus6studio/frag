// Minimal type surface for the placeholder scene.
// @types/three@0.187 depends on @dimforge/rapier3d-compat, and this repo does
// not take a physics engine. The runtime import is still the three package.

declare module "three" {
  export class Vector3 {
    set(x: number, y: number, z: number): this;
  }

  export class Euler {
    x: number;
    y: number;
    z: number;
  }

  export class Color {
    constructor(color: number);
  }

  export class Object3D {
    position: Vector3;
    rotation: Euler;
  }

  export class Scene extends Object3D {
    background: Color | null;
    add(...objects: Object3D[]): this;
  }

  export class PerspectiveCamera extends Object3D {
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    aspect: number;
    lookAt(x: number, y: number, z: number): void;
    updateProjectionMatrix(): void;
  }

  export class BufferGeometry {}

  export class BoxGeometry extends BufferGeometry {
    constructor(width?: number, height?: number, depth?: number);
  }

  export class Material {}

  export class MeshStandardMaterial extends Material {
    constructor(parameters?: {
      color?: number;
      roughness?: number;
      metalness?: number;
    });
  }

  export class Mesh extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material);
  }

  export class Light extends Object3D {}

  export class DirectionalLight extends Light {
    constructor(color?: number, intensity?: number);
  }

  export class AmbientLight extends Light {
    constructor(color?: number, intensity?: number);
  }

  export interface WebGLRendererParameters {
    antialias?: boolean;
    preserveDrawingBuffer?: boolean;
  }

  export class WebGLRenderer {
    constructor(parameters?: WebGLRendererParameters);
    domElement: HTMLCanvasElement;
    setPixelRatio(value: number): void;
    setSize(width: number, height: number): void;
    render(scene: Scene, camera: PerspectiveCamera): void;
  }
}
