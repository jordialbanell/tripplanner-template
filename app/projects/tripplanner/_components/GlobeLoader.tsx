'use client';

import { useEffect, useRef, useState } from 'react';

// Full-area loading screen: a slowly turning 3D Earth until the page says everything is ready
// (data and the map), then a short fade. A safety timer lifts it if something never reports in.
// The model is public/apps/tripplanner/globe.glb (a low-poly Earth, slimmed to ~250 KB).

// On phones the map starts hidden behind the list, so pages don't wait for it there.
export function useMapShownOnLoad(): boolean {
  const [shown, setShown] = useState(true);
  useEffect(() => { setShown(window.matchMedia('(min-width: 768px)').matches); }, []);
  return shown;
}

const MODEL = '/apps/tripplanner/globe.glb';
const SIZE = 150; // px

// size in px. extraSpin (radians per ms, read every frame) lets the chat globe spin when thrown
// or while thinking.
export function Earth({ size = SIZE, extraSpin }: { size?: number; extraSpin?: { current: number } }) {
  const box = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stop = false;
    let frame = 0;
    let cleanup = () => {};
    (async () => {
      const THREE = await import('three');
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');
      if (stop || !box.current) return;

      let renderer: import('three').WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      } catch { return; } // no WebGL: the label alone still shows
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(size, size);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      box.current.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 2.2));
      const sun = new THREE.DirectionalLight(0xffffff, 1.6);
      sun.position.set(3, 4, 5);
      scene.add(sun);

      const tilt = new THREE.Group();
      // Upright, north at the top (no axial tilt).
      const spin = new THREE.Group();
      tilt.add(spin);
      scene.add(tilt);

      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      loader.load(MODEL, gltf => {
        if (stop) return;
        const model = gltf.scene;
        const bounds = new THREE.Box3().setFromObject(model);
        model.position.sub(bounds.getCenter(new THREE.Vector3()));
        spin.add(model);
        spin.rotation.y = -0.6; // start with Europe and Africa facing us
        const extent = bounds.getSize(new THREE.Vector3()).length();
        camera.position.set(0, 0, extent * 1.22); // globe fills ~90% of the box
        camera.lookAt(0, 0, 0);
        setReady(true);

        const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        let last = performance.now();
        const tick = (now: number) => {
          const dt = Math.min(now - last, 50);
          last = now;
          if (!still) spin.rotation.y += dt * 0.00045; // one turn every ~14 s
          if (extraSpin) spin.rotation.y += dt * extraSpin.current;
          renderer.render(scene, camera);
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      }, undefined, () => { /* model failed: the label alone still shows */ });

      cleanup = () => {
        cancelAnimationFrame(frame);
        scene.traverse(o => {
          const m = o as import('three').Mesh;
          m.geometry?.dispose?.();
          const mat = m.material as import('three').Material | import('three').Material[] | undefined;
          (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach(x => x.dispose());
        });
        renderer.dispose();
        renderer.domElement.remove();
      };
    })();
    return () => { stop = true; cleanup(); };
  }, [size, extraSpin]);

  return (
    <div
      ref={box}
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={`transition-opacity duration-500 ${ready ? 'opacity-100' : 'opacity-0'}`}
    />
  );
}

export function GlobeLoader({ show, label = 'Loading TripPlanner', maxMs = 15000 }: { show: boolean; label?: string; maxMs?: number }) {
  const [gone, setGone] = useState(!show);
  const [fading, setFading] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!show) return;
    const t = setTimeout(() => setTimedOut(true), maxMs);
    return () => clearTimeout(t);
  }, [show, maxMs]);

  const visible = show && !timedOut;
  useEffect(() => {
    if (visible) { setGone(false); setFading(false); return; }
    setFading(true);
    const t = setTimeout(() => setGone(true), 400);
    return () => clearTimeout(t);
  }, [visible]);

  if (gone) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-white transition-opacity duration-400 ${fading ? 'pointer-events-none opacity-0' : 'opacity-100'}`}
    >
      <Earth />
      <p className="text-sm text-gray-500">{label}…</p>
    </div>
  );
}
