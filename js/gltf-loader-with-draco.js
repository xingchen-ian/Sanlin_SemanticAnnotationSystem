/**
 * 包装 GLTFLoader，在 parse 前自动注入 DRACOLoader，供 3d-tiles-renderer 的 B3DMLoader 使用。
 * import map 将 three/examples/jsm/loaders/GLTFLoader.js 指向本文件，确保库内用的也是带 DRACO 的 loader。
 */
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/loaders/DRACOLoader.js';

const DRACO_PATH = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/gltf/';
const _parse = GLTFLoader.prototype.parse;
GLTFLoader.prototype.parse = function parse(data, path, onLoad, onError) {
  if (!this.dracoLoader) {
    const draco = new DRACOLoader();
    draco.setDecoderPath(DRACO_PATH);
    this.setDRACOLoader(draco);
  }
  return _parse.call(this, data, path, onLoad, onError);
};

export { GLTFLoader };
