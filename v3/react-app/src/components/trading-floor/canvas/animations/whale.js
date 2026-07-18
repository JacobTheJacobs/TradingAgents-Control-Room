export function createWhaleAnim(scene, key) {
  scene.anims.create({ key: `${key}_whale`, frames: scene.anims.generateFrameNumbers(key, { start: 152, end: 155 }), frameRate: 8, repeat: -1 })
}
