export function createHodlAnim(scene, key) {
  scene.anims.create({ key: `${key}_hodl`, frames: scene.anims.generateFrameNumbers(key, { start: 84, end: 87 }), frameRate: 8, repeat: -1 })
}
