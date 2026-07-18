export function createBuydipAnim(scene, key) {
  scene.anims.create({ key: `${key}_buydip`, frames: scene.anims.generateFrameNumbers(key, { start: 132, end: 135 }), frameRate: 8, repeat: -1 })
}
