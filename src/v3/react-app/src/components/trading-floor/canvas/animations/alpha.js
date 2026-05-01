export function createAlphaAnim(scene, key) {
  scene.anims.create({
    key: `${key}_alpha`,
    frames: scene.anims.generateFrameNumbers(key, { start: 168, end: 171 }),
    frameRate: 6,
    repeat: -1
  })
}
