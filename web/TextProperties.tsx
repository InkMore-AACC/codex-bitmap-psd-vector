import type { Layer } from './types';
export default function TextProperties({
  layer,
  update,
}: {
  layer: Layer;
  update: (fn: (l: Layer) => void) => void;
}) {
  if (!layer.text) return null;
  const edit = (fn: (l: Layer) => void) =>
    update((l) => {
      fn(l);
      l.textDirty = true;
    });
  return (
    <details className="text-properties">
      <summary>可编辑文字属性</summary>
      <p>基础文字、描边与阴影可直接编辑。复杂字形可通过修改意见重建。</p>
      <label>
        文字
        <textarea
          aria-label="文字内容"
          value={layer.text.value}
          onChange={(e) =>
            edit((l) => {
              l.text!.value = e.target.value;
            })
          }
        />
      </label>
      <label>
        字体
        <input
          aria-label="字体名称"
          value={layer.text.fontFamily}
          onChange={(e) =>
            edit((l) => {
              l.text!.fontFamily = e.target.value;
            })
          }
        />
      </label>
      <div className="property-row">
        <label>
          字号
          <input
            type="number"
            min="1"
            max="5000"
            aria-label="字号"
            value={layer.text.fontSize}
            onChange={(e) =>
              edit((l) => {
                l.text!.fontSize = Math.max(1, Math.min(5000, Number(e.target.value) || 1));
              })
            }
          />
        </label>
        <label>
          颜色
          <input
            type="color"
            aria-label="文字颜色"
            value={/^#[\da-f]{6}$/i.test(layer.text.color) ? layer.text.color : '#ffffff'}
            onChange={(e) =>
              edit((l) => {
                l.text!.color = e.target.value;
              })
            }
          />
        </label>
      </div>
      <label className="effect-toggle">
        <input
          type="checkbox"
          checked={!!layer.psdStyle?.stroke}
          onChange={(e) =>
            edit((l) => {
              l.psdStyle ||= {};
              l.psdStyle.stroke = e.target.checked ? { color: '#ffffff', size: 2 } : undefined;
            })
          }
        />
        描边
      </label>
      {layer.psdStyle?.stroke && (
        <div className="property-row">
          <label>
            宽度
            <input
              type="number"
              min="0"
              max="500"
              aria-label="描边宽度"
              value={layer.psdStyle.stroke.size}
              onChange={(e) =>
                edit((l) => {
                  l.psdStyle!.stroke!.size = Math.max(
                    0,
                    Math.min(500, Number(e.target.value) || 0),
                  );
                })
              }
            />
          </label>
          <label>
            颜色
            <input
              type="color"
              aria-label="描边颜色"
              value={layer.psdStyle.stroke.color}
              onChange={(e) =>
                edit((l) => {
                  l.psdStyle!.stroke!.color = e.target.value;
                })
              }
            />
          </label>
        </div>
      )}
      <label className="effect-toggle">
        <input
          type="checkbox"
          checked={!!layer.psdStyle?.shadow}
          onChange={(e) =>
            edit((l) => {
              l.psdStyle ||= {};
              l.psdStyle.shadow = e.target.checked
                ? { color: '#000000', blur: 8, offsetX: 3, offsetY: 3, opacity: 0.5 }
                : undefined;
            })
          }
        />
        阴影
      </label>
      {layer.psdStyle?.shadow && (
        <>
          <div className="property-row">
            <label>
              模糊
              <input
                type="number"
                min="0"
                max="500"
                aria-label="阴影模糊"
                value={layer.psdStyle.shadow.blur}
                onChange={(e) =>
                  edit((l) => {
                    l.psdStyle!.shadow!.blur = Math.max(
                      0,
                      Math.min(500, Number(e.target.value) || 0),
                    );
                  })
                }
              />
            </label>
            <label>
              颜色
              <input
                type="color"
                aria-label="阴影颜色"
                value={layer.psdStyle.shadow.color}
                onChange={(e) =>
                  edit((l) => {
                    l.psdStyle!.shadow!.color = e.target.value;
                  })
                }
              />
            </label>
          </div>
          <div className="property-row">
            <label>
              水平偏移
              <input
                type="number"
                min="-100000"
                max="100000"
                aria-label="阴影水平偏移"
                value={layer.psdStyle.shadow.offsetX}
                onChange={(e) =>
                  edit((l) => {
                    l.psdStyle!.shadow!.offsetX = Number(e.target.value) || 0;
                  })
                }
              />
            </label>
            <label>
              垂直偏移
              <input
                type="number"
                min="-100000"
                max="100000"
                aria-label="阴影垂直偏移"
                value={layer.psdStyle.shadow.offsetY}
                onChange={(e) =>
                  edit((l) => {
                    l.psdStyle!.shadow!.offsetY = Number(e.target.value) || 0;
                  })
                }
              />
            </label>
          </div>
        </>
      )}
    </details>
  );
}
