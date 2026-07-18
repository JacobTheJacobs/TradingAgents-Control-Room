export function createFacepalmAnim(scene, key) {
  scene.anims.create({ key: `${key}_facepalm`, frames: scene.anims.generateFrameNumbers(key, { start: 52, end: 55 }), frameRate: 5, repeat: -1 })
}
