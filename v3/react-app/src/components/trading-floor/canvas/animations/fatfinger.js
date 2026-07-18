export function createFatfingerAnim(scene, key) {
  scene.anims.create({ key: `${key}_fatfinger`, frames: scene.anims.generateFrameNumbers(key, { start: 140, end: 143 }), frameRate: 8, repeat: -1 })
}
