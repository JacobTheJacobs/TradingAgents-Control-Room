export function createReadAnim(scene, key) {
  // Keep read loop on non-glare frames to avoid bright white lens flashes.
  scene.anims.create({ key: `${key}_read`, frames: scene.anims.generateFrameNumbers(key, { start: 20, end: 21 }), frameRate: 2, repeat: -1 })
}
