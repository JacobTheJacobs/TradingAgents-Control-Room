export function createTaxmanAnim(scene, key) {
  scene.anims.create({
    key: `${key}_taxman`,
    frames: scene.anims.generateFrameNumbers(key, { start: 164, end: 167 }),
    frameRate: 8,
    repeat: -1
  })
}
