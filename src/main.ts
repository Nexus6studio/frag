import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from "three";

const renderer = new WebGLRenderer({
  antialias: true,
  // The headless smoke test reads pixels after the browser composites.
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(0x111118);

const camera = new PerspectiveCamera(
  50,
  window.innerWidth / Math.max(window.innerHeight, 1),
  0.1,
  100,
);
camera.position.set(1.8, 1.2, 2.6);
camera.lookAt(0, 0, 0);

const cube = new Mesh(
  new BoxGeometry(1, 1, 1),
  new MeshStandardMaterial({
    color: 0x3dff9a,
    roughness: 0.35,
    metalness: 0.05,
  }),
);
scene.add(cube);

const keyLight = new DirectionalLight(0xffffff, 2.4);
keyLight.position.set(3, 5, 2);
scene.add(keyLight);
scene.add(new AmbientLight(0xffffff, 0.45));

function resize(): void {
  const width = window.innerWidth;
  const height = Math.max(window.innerHeight, 1);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
}

window.addEventListener("resize", resize);

function frame(time: number): void {
  cube.rotation.x = time * 0.0004;
  cube.rotation.y = time * 0.001;
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
