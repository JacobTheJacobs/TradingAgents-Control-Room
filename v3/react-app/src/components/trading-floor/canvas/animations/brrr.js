export function createBrrrAnim(scene, key) {
  scene.anims.create({ key: `${key}_brrr`, frames: scene.anims.generateFrameNumbers(key, { start: 116, end: 119 }), frameRate: 12, repeat: -1 })
}
