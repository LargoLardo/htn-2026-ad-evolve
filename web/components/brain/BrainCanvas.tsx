'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

/** The mesh is fsaverage5 in left-then-right vertex order, the same order the worker
 *  scores, and aFamily is the Percept family each vertex belongs to (0 = none, 1-4 in
 *  FAMILIES order). See experimental/export_brain_mesh.py. */
const MESH_FILES = ['positions.f32', 'indices.u32', 'sulc.f32', 'family.u8'] as const;

const vertexShader = /* glsl */ `
  attribute float aSulc;
  attribute float aFamily;

  varying vec3 vNormalView;
  varying vec3 vPositionView;
  varying float vSulc;
  varying vec4 vFamilyMask;

  void main() {
    vNormalView = normalize(normalMatrix * normal);
    vSulc = aSulc;
    // One-hot here, so a triangle spanning two families blends those two rather
    // than interpolating the index through whatever family sits between them.
    vFamilyMask = vec4(
      step(0.5, aFamily) * step(aFamily, 1.5),
      step(1.5, aFamily) * step(aFamily, 2.5),
      step(2.5, aFamily) * step(aFamily, 3.5),
      step(3.5, aFamily)
    );
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    vPositionView = viewPosition.xyz;
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uActivityLevel;
  uniform vec4 uFamilyLevel;
  uniform vec4 uFamilyFocus;
  uniform vec3 uFamilyColor[4];

  varying vec3 vNormalView;
  varying vec3 vPositionView;
  varying float vSulc;
  varying vec4 vFamilyMask;

  void main() {
    vec3 normal = normalize(vNormalView);
    vec3 toEye = normalize(-vPositionView);

    // Gyri stay pale and sulci darken, which is what makes the folding readable.
    vec3 base = mix(vec3(0.91, 0.88, 0.82), vec3(0.55, 0.51, 0.47), smoothstep(-0.6, 0.9, vSulc));
    float lambert = 0.45 + 0.55 * max(dot(normal, normalize(vec3(0.4, 0.7, 0.9))), 0.0);
    float rim = pow(1.0 - max(dot(normal, toEye), 0.0), 2.5);
    vec3 shaded = base * lambert + vec3(0.22, 0.24, 0.30) * rim;

    vec4 mask = vFamilyMask;
    float share = mask.x + mask.y + mask.z + mask.w;
    vec3 tint = (mask.x * uFamilyColor[0] + mask.y * uFamilyColor[1]
      + mask.z * uFamilyColor[2] + mask.w * uFamilyColor[3]) / max(share, 0.0001);
    float level = dot(mask, uFamilyLevel * uFamilyFocus) * uActivityLevel;

    // Wash rather than paint: the tint carries the surface shading, so gyri and
    // sulci stay legible through a lit family instead of flattening into a decal.
    vec3 wash = tint * (0.45 + 0.55 * lambert);
    vec3 color = mix(shaded, wash, level * 0.62) + tint * level * 0.12;
    gl_FragColor = vec4(color, 1.0);
  }
`;

async function loadMesh(): Promise<THREE.BufferGeometry> {
  const responses = await Promise.all(MESH_FILES.map((name) => fetch(`/brain/${name}`)));
  for (const response of responses) {
    if (!response.ok) throw new Error('The brain mesh is missing. Run experimental/export_brain_mesh.py.');
  }
  const [positions, indices, sulc, families] = await Promise.all(
    responses.map((response) => response.arrayBuffer())
  );

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  geometry.setAttribute('aSulc', new THREE.BufferAttribute(new Float32Array(sulc), 1));
  geometry.setAttribute(
    'aFamily',
    new THREE.BufferAttribute(Float32Array.from(new Uint8Array(families)), 1)
  );
  geometry.computeVertexNormals();
  return geometry;
}

function Cortex({
  geometry,
  levels,
  colors,
  activityLevel,
  selected,
  onSelect,
  onHover,
}: {
  geometry: THREE.BufferGeometry;
  levels: number[];
  colors: string[];
  activityLevel: number;
  selected: number;
  onSelect: (family: number) => void;
  onHover: (family: number) => void;
}) {
  const material = useRef<THREE.ShaderMaterial>(null);
  const pressed = useRef<{ x: number; y: number } | null>(null);
  const uniforms = useMemo(
    () => ({
      uActivityLevel: { value: 0 },
      uFamilyLevel: { value: new THREE.Vector4(0, 0, 0, 0) },
      uFamilyFocus: { value: new THREE.Vector4(1, 1, 1, 1) },
      uFamilyColor: { value: colors.map((color) => new THREE.Color(color)) },
    }),
    // Colours come from the scoring contract and are fixed for the life of the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const familyAt = (faceIndex?: number | null) => {
    const index = geometry.index;
    const family = geometry.getAttribute('aFamily');
    if (faceIndex === undefined || faceIndex === null || !index) return 0;
    return family.getX(index.getX(faceIndex * 3));
  };

  // Ease every level rather than snapping, so the playhead reads as a signal
  // moving through the cortex instead of four lamps flicking on and off.
  useFrame((_state, delta) => {
    if (!material.current) return;
    const step = Math.min(1, delta * 6);
    const current = material.current.uniforms.uFamilyLevel.value as THREE.Vector4;
    current.x += ((levels[0] ?? 0) - current.x) * step;
    current.y += ((levels[1] ?? 0) - current.y) * step;
    current.z += ((levels[2] ?? 0) - current.z) * step;
    current.w += ((levels[3] ?? 0) - current.w) * step;

    const focus = material.current.uniforms.uFamilyFocus.value as THREE.Vector4;
    const target = [1, 2, 3, 4].map((family) => (selected === 0 || selected === family ? 1 : 0.28));
    focus.x += (target[0] - focus.x) * step;
    focus.y += (target[1] - focus.y) * step;
    focus.z += (target[2] - focus.z) * step;
    focus.w += (target[3] - focus.w) * step;

    const activity = material.current.uniforms.uActivityLevel;
    activity.value += (activityLevel - activity.value) * Math.min(1, delta * 4);
  });

  return (
    <mesh
      geometry={geometry}
      onPointerDown={(event) => {
        pressed.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={(event) => {
        // A drag is how the camera orbits, so only a near-stationary click selects.
        const start = pressed.current;
        pressed.current = null;
        if (!start) return;
        const travelled = Math.hypot(event.clientX - start.x, event.clientY - start.y);
        if (travelled > 4) return;
        onSelect(familyAt(event.faceIndex));
      }}
      onPointerMove={(event) => onHover(familyAt(event.faceIndex))}
      onPointerOut={() => onHover(0)}
    >
      <shaderMaterial
        ref={material}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
      />
    </mesh>
  );
}

export default function BrainCanvas({
  levels,
  colors,
  activityLevel,
  selected,
  onSelect,
}: {
  levels: number[];
  colors: string[];
  activityLevel: number;
  selected: number;
  onSelect: (family: number) => void;
}) {
  const [mesh, setMesh] = useState<THREE.BufferGeometry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState(0);
  const controls = useRef<OrbitControlsImpl>(null);
  // +X is the right ear, +Y is up and +Z is posterior, so the starting camera is a
  // right three-quarter view with the occipital pole toward the viewer.

  useEffect(() => {
    let cancelled = false;
    loadMesh().then(
      (geometry) => {
        if (cancelled) geometry.dispose();
        else setMesh(geometry);
      },
      (caught: Error) => {
        if (!cancelled) setError(caught.message);
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => mesh?.dispose(), [mesh]);

  if (error) {
    return (
      <div className="grid size-full place-items-center px-6 text-center text-sm text-foreground-lighter">
        {error}
      </div>
    );
  }

  if (!mesh) {
    return (
      <div className="grid size-full place-items-center text-sm text-foreground-lighter">
        Loading the cortical surface…
      </div>
    );
  }

  return (
    <Canvas
      camera={{ position: [2.7, 0.55, 1.5], fov: 35 }}
      dpr={[1, 2]}
      style={{ cursor: hovered > 0 ? 'pointer' : 'default' }}
      onPointerMissed={() => onSelect(0)}
    >
      <Cortex
        geometry={mesh}
        levels={levels}
        colors={colors}
        activityLevel={activityLevel}
        selected={selected}
        onSelect={onSelect}
        onHover={setHovered}
      />
      <OrbitControls
        ref={controls}
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minDistance={1.4}
        maxDistance={6}
      />
      <Html fullscreen style={{ pointerEvents: 'none' }}>
        <div className="flex size-full items-end justify-center pb-5">
          <button
            type="button"
            onClick={() => controls.current?.reset()}
            style={{ pointerEvents: 'auto' }}
            className="focus-ring rounded-md border border-white/20 bg-black/60 px-3 py-1.5 text-[11px] uppercase tracking-[0.12em] text-white/80 backdrop-blur transition-colors hover:text-white"
          >
            Reset view
          </button>
        </div>
      </Html>
    </Canvas>
  );
}
