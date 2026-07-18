export function createLeverageAnim(scene, key) {
  scene.anims.create({ key: `${key}_leverage`, frames: scene.anims.generateFrameNumbers(key, { start: 144, end: 147 }), frameRate: 8, repeat: -1 })
}
