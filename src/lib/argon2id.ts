import setupWasm from 'argon2id/lib/setup.js';
import type { computeHash } from 'argon2id';
import simdWasmUrl from 'argon2id/dist/simd.wasm?url';
import nonSimdWasmUrl from 'argon2id/dist/no-simd.wasm?url';

function decodeDataUrl(dataUrl: string): ArrayBuffer {
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex === -1) {
    throw new Error('Invalid Wasm data URL');
  }

  const header = dataUrl.slice(0, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);

  if (header.endsWith(';base64')) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  }

  return new TextEncoder().encode(decodeURIComponent(payload)).buffer;
}

async function instantiateWasm(
  wasmUrl: string,
  importObject: WebAssembly.Imports,
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  if (wasmUrl.startsWith('data:')) {
    return WebAssembly.instantiate(decodeDataUrl(wasmUrl), importObject);
  }

  const response = await fetch(wasmUrl);
  if (!response.ok) {
    throw new Error(`Failed to load Argon2id module: ${response.status}`);
  }

  if ('instantiateStreaming' in WebAssembly) {
    try {
      return await WebAssembly.instantiateStreaming(response.clone(), importObject);
    } catch {
      // Fall back to ArrayBuffer instantiation when the browser serves Wasm with the wrong MIME type.
    }
  }

  return WebAssembly.instantiate(await response.arrayBuffer(), importObject);
}

export type { computeHash };

export function loadArgon2id(): Promise<computeHash> {
  return setupWasm(
    (importObject) => instantiateWasm(simdWasmUrl, importObject),
    (importObject) => instantiateWasm(nonSimdWasmUrl, importObject),
  );
}
