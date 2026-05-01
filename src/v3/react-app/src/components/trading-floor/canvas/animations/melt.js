export function createMeltAnim(scene, key) {
  scene.anims.create({ key: `${key}_melt`, frames: scene.anims.generateFrameNumbers(key, { start: 128, end: 131 }), frameRate: 6, repeat: -1 })
}
