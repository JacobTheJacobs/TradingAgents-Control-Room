export function createGlitchAnim(scene, key) {
  scene.anims.create({
    key: `${key}_glitch`,
    frames: scene.anims.generateFrameNumbers(key, { start: 176, end: 179 }),
    frameRate: 12,
    repeat: -1
  })
}
