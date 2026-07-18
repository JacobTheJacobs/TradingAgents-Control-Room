export function createTalkAnim(scene, key) {
  scene.anims.create({ key: `${key}_talk`, frames: scene.anims.generateFrameNumbers(key, { start: 32, end: 35 }), frameRate: 6, repeat: -1 })
}
