import setupWasm from 'argon2id/lib/setup.js';
import type { computeHash } from 'argon2id';
import simdWasmUrl from 'argon2id/dist/simd.wasm?url';
import nonSimdWasmUrl from 'argon2id/dist/no-simd.wasm?url';

async function instantiateWasm(
  wasmUrl: string,
  importObject: WebAssembly.Imports,
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
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
