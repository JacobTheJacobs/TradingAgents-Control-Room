export function createSellAnim(scene, key) {
  scene.anims.create({ key: `${key}_sell`, frames: scene.anims.generateFrameNumbers(key, { start: 92, end: 95 }), frameRate: 8, repeat: -1 })
}
