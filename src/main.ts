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
import { createInput } from "./input";
import { createLook } from "./look";
import { mountShell } from "./shell";

const renderer = new WebGLRenderer({
  antialias: true,
  // The headless smoke test reads pixels after the browser composites.
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
const shell = mountShell(renderer.domElement);
const input = createInput(renderer.domElement);

const scene = new Scene();
scene.background = new Color(0x111118);

const camera = new PerspectiveCamera(50, 1, 0.1, 100);
camera.position.set(1.8, 1.2, 2.6);
camera.rotation.order = "YXZ";
camera.lookAt(0, 0, 0);
const look = createLook(camera);
// The smoke test reads the live camera fov from the canvas.
Object.defineProperty(renderer.domElement, "fragView", {
  configurable: true,
  enumerable: false,
  value: look.view,
});

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
  // 105° horizontal. PerspectiveCamera.fov is vertical; look.resize derives it.
  look.resize(window.innerWidth, window.innerHeight);
  renderer.setSize(window.innerWidth, window.innerHeight);
}

window.addEventListener("resize", resize);
resize();

function frame(time: number): void {
  const captured =
    shell.phase === "playing" && document.pointerLockElement === renderer.domElement;
  const controls = input.sample(captured);
  if (captured) {
    look.apply(controls.lookX, controls.lookY);
    if (controls.pressed.sensUp) look.nudgeSensitivity(1);
    if (controls.pressed.sensDown) look.nudgeSensitivity(-1);
  }
  // Move, jump, fire, and reload stay on `controls` for later tickets.
  shell.onFrame(time, {
    x: camera.position.x,
    y: camera.position.y,
    z: camera.position.z,
    yaw: look.yaw,
    pitch: look.pitch,
    sensitivity: look.sensitivity,
  });
  cube.rotation.x = time * 0.0004;
  cube.rotation.y = time * 0.001;
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
