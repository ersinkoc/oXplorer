#!/bin/sh
# Builds the demo folders the README screenshots show (scripts/screenshots.sh):
# a small project under Git with changes, generated artwork and a few documents.
# Usage: scripts/demo-content.sh "/Users/Shared/OXplorer Demo"
set -eu
root=${1:?usage: demo-content.sh <folder>}
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
rm -rf "$root"
mkdir -p "$root"
cd "$root"

# --- A project under Git -----------------------------------------------------
mkdir -p aurora/src aurora/web aurora/docs aurora/assets aurora/target/release
cd aurora
cat > README.md <<'EOF'
# Aurora

A tiny real-time renderer for **procedural skies**, written in Rust with a web preview.

## Features

- Physically based atmosphere with Rayleigh and Mie scattering
- Aurora curtains driven by layered noise
- Hot-reloading scene files (`scenes/*.toml`)
- A WebGPU preview you can open in any browser

## Getting started

```sh
cargo run --release -- scenes/northern-lights.toml
```

| Scene            | Frame time |
|------------------|-----------:|
| Northern lights  |    2.1 ms  |
| Desert dusk      |    1.7 ms  |
EOF
cat > Cargo.toml <<'EOF'
[package]
name = "aurora"
version = "0.4.2"
edition = "2024"

[dependencies]
glam = "0.29"
wgpu = "26"
noise = "0.9"
serde = { version = "1", features = ["derive"] }
toml = "0.9"
EOF
cat > src/main.rs <<'EOF'
use aurora::{Renderer, Scene};
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).unwrap_or_else(|| "scenes/northern-lights.toml".into());
    let scene = Scene::load(&path)?;
    let mut renderer = Renderer::new(1920, 1080)?;

    let start = Instant::now();
    loop {
        let t = start.elapsed().as_secs_f32();
        let frame = renderer.draw(&scene, t)?;
        if frame.index % 120 == 0 {
            println!("frame {:>6}  {:.2} ms", frame.index, frame.millis);
        }
    }
}
EOF
cat > src/lib.rs <<'EOF'
mod render;
mod scene;
mod sky;

pub use render::Renderer;
pub use scene::Scene;
EOF
cat > src/render.rs <<'EOF'
use crate::{Scene, sky::Sky};
use glam::Vec3;

pub struct Frame {
    pub index: u64,
    pub millis: f32,
}

/// Draws one frame of a scene: sky first, then the aurora on top.
pub struct Renderer {
    width: u32,
    height: u32,
    frames: u64,
}

impl Renderer {
    pub fn new(width: u32, height: u32) -> anyhow::Result<Self> {
        Ok(Self { width, height, frames: 0 })
    }

    pub fn draw(&mut self, scene: &Scene, t: f32) -> anyhow::Result<Frame> {
        let sky = Sky::new(scene.sun_direction(t), Vec3::new(0.3, 0.5, 1.0));
        let _ = (sky, self.width, self.height);
        self.frames += 1;
        Ok(Frame { index: self.frames, millis: 2.1 })
    }
}
EOF
cat > src/scene.rs <<'EOF'
use glam::Vec3;
use serde::Deserialize;

#[derive(Deserialize)]
pub struct Scene {
    pub name: String,
    pub latitude: f32,
    pub intensity: f32,
}

impl Scene {
    pub fn load(path: &str) -> anyhow::Result<Self> {
        Ok(toml::from_str(&std::fs::read_to_string(path)?)?)
    }

    pub fn sun_direction(&self, t: f32) -> Vec3 {
        Vec3::new(t.cos(), (self.latitude.to_radians() + t * 0.01).sin(), t.sin()).normalize()
    }
}
EOF
cat > src/sky.rs <<'EOF'
use glam::Vec3;

pub struct Sky {
    pub sun: Vec3,
    pub tint: Vec3,
}

impl Sky {
    pub fn new(sun: Vec3, tint: Vec3) -> Self {
        Self { sun, tint }
    }
}
EOF
cat > web/index.html <<'EOF'
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Aurora preview</title></head>
  <body><canvas id="sky"></canvas><script type="module" src="app.ts"></script></body>
</html>
EOF
cat > web/app.ts <<'EOF'
const canvas = document.querySelector<HTMLCanvasElement>("#sky")!;
const adapter = await navigator.gpu.requestAdapter();
console.log("Aurora preview on", adapter?.info.vendor ?? "unknown GPU", canvas.width);
EOF
cat > docs/architecture.md <<'EOF'
# Architecture

The renderer runs a single pass per frame: sky, aurora, tone mapping.
EOF
printf 'target/\n.DS_Store\n' > .gitignore
printf 'MIT License\n\nCopyright (c) 2026 The Aurora authors\n' > LICENSE
head -c 900000 /dev/urandom > target/release/aurora
git init -q -b main
git -c user.name=Aurora -c user.email=aurora@example.com add -A
git -c user.name=Aurora -c user.email=aurora@example.com commit -q -m "Aurora 0.4.2"
# Work in progress: a changed file and a new one.
printf '\n// TODO: tone mapping (ACES)\n' >> src/render.rs
cat > src/light.rs <<'EOF'
use glam::Vec3;

/// Light scattered towards the viewer by air molecules (Rayleigh).
pub fn rayleigh(cos_theta: f32) -> f32 {
    3.0 / (16.0 * std::f32::consts::PI) * (1.0 + cos_theta * cos_theta)
}

pub fn extinction(height: f32) -> Vec3 {
    Vec3::new(5.8e-6, 13.5e-6, 33.1e-6) * (-height / 8000.0).exp()
}
EOF
cd ..

# --- Generated artwork ---------------------------------------------------------
mkdir -p Artwork
art=$(mktemp -d)
i=0
for spec in \
  "Northern Lights|#0b1d3a|#1fd1a5|#7b5cff" \
  "Desert Dusk|#2d1b3d|#ff8a5c|#ffd27a" \
  "Glacier|#e8f4ff|#7cc4ff|#2b6cb0" \
  "Coral Reef|#ff6b8b|#ffb36b|#5ad1c8" \
  "Midnight Forest|#071a14|#1e5b3a|#9be27a" \
  "Lavender Fields|#3b2a6b|#a68cff|#ffd1f0" \
  "Golden Hour|#5b2a00|#ff9d2e|#fff1b8" \
  "Deep Sea|#020b1f|#0b4f8a|#46e0ff"; do
  i=$((i + 1))
  name=${spec%%|*}
  rest=${spec#*|}
  a=${rest%%|*}; rest=${rest#*|}
  b=${rest%%|*}; c=${rest#*|}
  cat > "$art/$i.html" <<EOF
<html><body style="margin:0;width:1600px;height:1000px;overflow:hidden;
background:radial-gradient(circle at $((i * 11 % 80 + 10))% $((i * 23 % 60 + 20))%, $c 0, transparent 45%),
radial-gradient(ellipse at $((100 - i * 9 % 70))% 90%, $b 0, transparent 60%),
linear-gradient($((i * 37))deg, $a, $b)">
<div style="position:absolute;inset:0;background:repeating-linear-gradient($((i * 53))deg, rgba(255,255,255,.05) 0 2px, transparent 2px 40px)"></div>
</body></html>
EOF
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --window-size=1600,1000 \
    --screenshot="$art/$i.png" "file://$art/$i.html" >/dev/null 2>&1
  sips -s format jpeg -s formatOptions 85 "$art/$i.png" --out "Artwork/$name.jpg" >/dev/null
done
sips -s format pdf "Artwork/Glacier.jpg" --out "$art/glacier.pdf" >/dev/null
rm -rf "$art"

# --- Documents -----------------------------------------------------------------
mkdir -p Documents/Invoices
cat > "Documents/Meeting Notes.md" <<'EOF'
# Planning — Q3

- Ship the WebGPU preview
- Profile the scattering pass on older GPUs
- Write the scene file guide
EOF
printf 'month,visitors,downloads\nJuly,18420,2210\nAugust,21877,2894\nSeptember,24310,3302\n' > Documents/stats.csv
for m in July August September; do
  sips -s format pdf "Artwork/Golden Hour.jpg" --out "Documents/Invoices/Invoice $m.pdf" >/dev/null
done
sips -s format pdf "Artwork/Deep Sea.jpg" --out "Documents/Poster.pdf" >/dev/null
(cd Documents && zip -qr "../Backup 2026-09.zip" "Meeting Notes.md" stats.csv Invoices)
echo "demo content in $root"
