// Decode a captured *bound range* only when WGSL supplies an unambiguous
// uniform declaration and the complete struct fits the captured bytes.
// No guesses from buffer labels, untyped bytes, or capture-final resources.
(function () {
  'use strict';

  const MAX_LAYOUT_BYTES = 1024 * 1024;
  const MAX_FIELDS = 256;
  const MAX_ARRAY_ELEMENTS = 256;
  const IDENT = /^[A-Za-z_]\w*$/;
  const roundUp = (align, size) => Math.ceil(size / align) * align;
  const unavailable = reason => ({ status: 'unavailable', reason });

  function stripComments(source) {
    let clean = '';
    let depth = 0;
    for (let i = 0; i < source.length;) {
      if (!depth && source.slice(i, i + 2) === '//') {
        while (i < source.length && source[i] !== '\n') i++;
      } else if (source.slice(i, i + 2) === '/*') {
        depth++;
        clean += '  ';
        i += 2;
      } else if (depth && source.slice(i, i + 2) === '*/') {
        depth--;
        clean += '  ';
        i += 2;
      } else {
        clean += depth && source[i] !== '\n' ? ' ' : source[i];
        i++;
      }
    }
    if (depth) throw new Error('WGSL 注释未闭合');
    return clean;
  }

  function splitComma(source) {
    const parts = [];
    let angle = 0;
    let paren = 0;
    let start = 0;
    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (char === '<') angle++;
      else if (char === '>') angle--;
      else if (char === '(') paren++;
      else if (char === ')') paren--;
      else if (char === ',' && angle === 0 && paren === 0) {
        parts.push(source.slice(start, i).trim());
        start = i + 1;
      }
      if (angle < 0 || paren < 0) throw new Error('WGSL 类型括号不匹配');
    }
    if (angle || paren) throw new Error('WGSL 类型括号未闭合');
    parts.push(source.slice(start).trim());
    return parts.filter(Boolean);
  }

  function bindingType(source, group, binding) {
    // Attribute order is not fixed in WGSL. Restrict this path to uniform
    // variables; storage buffers need runtime arrays and a different decoder.
    const declaration = /((?:@\w+\s*\([^()]*\)\s*)+)var\s*<\s*uniform\s*>\s*([A-Za-z_]\w*)\s*:\s*([A-Za-z_]\w*)\s*;/g;
    const matches = [];
    for (const match of source.matchAll(declaration)) {
      const attrs = [...match[1].matchAll(/@(group|binding)\s*\(\s*(\d+)\s*\)/g)];
      const groups = attrs.filter(item => item[1] === 'group');
      const bindings = attrs.filter(item => item[1] === 'binding');
      if (groups.length !== 1 || bindings.length !== 1) continue;
      if (Number(groups[0][2]) === group && Number(bindings[0][2]) === binding) {
        matches.push({ variable: match[2], structName: match[3] });
      }
    }
    if (matches.length > 1) throw new Error('同一 WGSL 模块对该绑定声明了多次 Uniform');
    return matches[0] || null;
  }

  function structMembers(source, name) {
    if (!IDENT.test(name)) throw new Error('WGSL struct 名称无效');
    const pattern = new RegExp(`\\bstruct\\s+${name}\\s*\\{([^{}]*)\\}\\s*;?`, 'g');
    const matches = [...source.matchAll(pattern)];
    if (matches.length !== 1) throw new Error(matches.length ? 'WGSL struct 定义不唯一' : 'WGSL struct 定义缺失或包含不支持的嵌套语法');
    const parts = splitComma(matches[0][1]);
    if (!parts.length || parts.length > MAX_FIELDS) throw new Error('WGSL struct 字段数量无效');
    return parts.map(part => {
      if (part.includes('@')) throw new Error('WGSL 字段属性未能安全解析');
      const field = /^([A-Za-z_]\w*)\s*:\s*(.+)$/.exec(part);
      if (!field) throw new Error(`WGSL 字段无法解析：${part.slice(0, 80)}`);
      return { name: field[1], type: field[2].trim() };
    });
  }

  function primitiveType(type) {
    const scalar = /^(f32|i32|u32|f16)$/.exec(type);
    if (scalar) {
      const bytes = scalar[1] === 'f16' ? 2 : 4;
      return { kind: 'scalar', scalar: scalar[1], align: bytes, size: bytes, components: 1 };
    }
    const vector = /^vec([234])\s*<\s*(f32|i32|u32|f16)\s*>$/.exec(type);
    if (vector) {
      const components = Number(vector[1]);
      const scalarBytes = vector[2] === 'f16' ? 2 : 4;
      return { kind: 'vector', scalar: vector[2], components,
        align: (components === 2 ? 2 : 4) * scalarBytes, size: components * scalarBytes };
    }
    const matrix = /^mat([234])x([234])\s*<\s*(f32|f16)\s*>$/.exec(type);
    if (matrix) {
      const columns = Number(matrix[1]);
      const rows = Number(matrix[2]);
      const scalarBytes = matrix[3] === 'f16' ? 2 : 4;
      const align = (rows === 2 ? 2 : 4) * scalarBytes;
      const stride = roundUp(align, rows * scalarBytes);
      return { kind: 'matrix', scalar: matrix[3], columns, rows, stride,
        components: columns * rows, align, size: columns * stride };
    }
    return null;
  }

  function typeLayout(type) {
    const primitive = primitiveType(type);
    if (primitive) return primitive;
    const array = /^array\s*<\s*(.*)\s*>$/.exec(type);
    if (!array) throw new Error(`不支持的 WGSL Uniform 类型：${type.slice(0, 80)}`);
    const [elementType, countText, ...rest] = splitComma(array[1]);
    const count = Number(countText);
    if (rest.length || !elementType || !/^[1-9]\d*$/.test(countText || '') ||
        !Number.isSafeInteger(count) || count > MAX_ARRAY_ELEMENTS) {
      throw new Error('WGSL Uniform 数组长度无法安全确定');
    }
    const element = primitiveType(elementType);
    if (!element) throw new Error('WGSL Uniform 数组元素不是可解码的标量、向量或矩阵');
    // Uniform-space arrays have at least 16-byte element alignment. This
    // supports the engine's vec4-array workaround for scalar arrays.
    const align = Math.max(16, element.align);
    const stride = roundUp(align, element.size);
    return { kind: 'array', element, count, align, stride, size: stride * count,
      components: element.components * count };
  }

  function structLayout(source, name) {
    const members = structMembers(source, name);
    let offset = 0;
    let align = 16;
    const fields = [];
    for (const field of members) {
      const layout = typeLayout(field.type);
      align = Math.max(align, layout.align);
      offset = roundUp(layout.align, offset);
      if (offset + layout.size > MAX_LAYOUT_BYTES || layout.components > 1024) {
        throw new Error('Uniform 结构超过安全解码上限');
      }
      fields.push({ ...field, offset, byteLength: layout.size, layout });
      offset += layout.size;
    }
    const size = roundUp(align, offset);
    if (size > MAX_LAYOUT_BYTES) throw new Error('Uniform 结构超过安全解码上限');
    return { fields, size, align };
  }

  function readScalar(view, offset, scalar) {
    if (scalar === 'f32') return view.getFloat32(offset, true);
    if (scalar === 'i32') return view.getInt32(offset, true);
    if (scalar === 'u32') return view.getUint32(offset, true);
    const bits = view.getUint16(offset, true);
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >> 10) & 31;
    const mantissa = bits & 1023;
    if (!exponent) return sign * 2 ** -14 * mantissa / 1024;
    if (exponent === 31) return mantissa ? NaN : sign * Infinity;
    return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
  }

  function decodeValue(view, offset, layout) {
    if (layout.kind === 'array') return Array.from({ length: layout.count }, (_, index) =>
      decodeValue(view, offset + index * layout.stride, layout.element));
    const scalarBytes = layout.scalar === 'f16' ? 2 : 4;
    if (layout.kind === 'matrix') return Array.from({ length: layout.columns }, (_, column) =>
      Array.from({ length: layout.rows }, (_, row) =>
        readScalar(view, offset + column * layout.stride + row * scalarBytes, layout.scalar)));
    if (layout.kind === 'vector') return Array.from({ length: layout.components }, (_, index) =>
      readScalar(view, offset + index * scalarBytes, layout.scalar));
    return readScalar(view, offset, layout.scalar);
  }

  function sameFields(a, b) {
    return a.size === b.size && a.fields.length === b.fields.length &&
      a.fields.every((field, index) => field.name === b.fields[index].name &&
        field.type === b.fields[index].type && field.offset === b.fields[index].offset &&
        field.byteLength === b.fields[index].byteLength);
  }

  /**
   * inspectBinding({ shaders, pipeline, group, binding, bytes, declaredSize })
   * bytes must begin at the captured binding range, not at buffer byte zero.
   * Returns {status:'ok', variable, structName, size, fields:[{name,type,offset,byteLength,value}]}
   * or {status:'unavailable', reason}. Never fabricates missing values.
   */
  function inspectBinding(input) {
    try {
      const { shaders, pipeline, group, binding, bytes, declaredSize } = input || {};
      if (!Array.isArray(shaders) || !pipeline || !Number.isSafeInteger(group) || group < 0 ||
          !Number.isSafeInteger(binding) || binding < 0) return unavailable('缺少管线、Shader 或绑定编号');
      let payload;
      if (bytes instanceof Uint8Array) payload = bytes;
      else if (bytes instanceof ArrayBuffer) payload = new Uint8Array(bytes);
      else return unavailable('未提供绑定范围的二进制字节');
      if (declaredSize != null && (!Number.isSafeInteger(declaredSize) || declaredSize < 0)) {
        return unavailable('绑定范围长度无效');
      }
      const ids = Array.isArray(pipeline.shaderIds) ? pipeline.shaderIds : [];
      if (!ids.length) return unavailable('管线没有可核实的 Shader 模块 ID');
      let chosen = null;
      for (const id of new Set(ids)) {
        const shader = shaders.find(item => String(item?.id) === String(id));
        if (!shader || typeof shader.code !== 'string') return unavailable(`Shader #${id} 的 WGSL 源码缺失`);
        if (shader.code.length > MAX_LAYOUT_BYTES) return unavailable('WGSL 源码超过解析上限');
        const code = stripComments(shader.code);
        const declaration = bindingType(code, group, binding);
        if (!declaration) continue;
        const layout = structLayout(code, declaration.structName);
        const found = { ...declaration, ...layout };
        if (chosen && !sameFields(chosen, found)) return unavailable('Shader 阶段对同一 Uniform 绑定的字段布局不一致');
        chosen ||= found;
      }
      if (!chosen) return unavailable('WGSL 未声明这个绑定为可解析的 Uniform struct');
      if (declaredSize != null && declaredSize < chosen.size) return unavailable('绑定范围小于 WGSL struct 字节大小');
      if (payload.byteLength < chosen.size) return unavailable(`捕获字节不完整：需 ${chosen.size} B，只有 ${payload.byteLength} B`);
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      return { status: 'ok', variable: chosen.variable, structName: chosen.structName,
        size: chosen.size, fields: chosen.fields.map(field => ({
          name: field.name, type: field.type, offset: field.offset,
          byteLength: field.byteLength, value: decodeValue(view, field.offset, field.layout),
        })) };
    } catch (error) {
      return unavailable(error?.message || String(error));
    }
  }

  window.GameDraftUniformInspector = Object.freeze({ inspectBinding });
}());
