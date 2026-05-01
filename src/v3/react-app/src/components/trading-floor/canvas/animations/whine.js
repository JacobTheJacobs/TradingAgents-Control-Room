export function createWhineAnim(scene, key) {
  scene.anims.create({ key: `${key}_whine`, frames: scene.anims.generateFrameNumbers(key, { start: 56, end: 59 }), frameRate: 6, repeat: -1 })
}
