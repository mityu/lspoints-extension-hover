import type { Denops } from "jsr:@denops/std@^7.1.0";
import { batch } from "jsr:@denops/std@^7.1.0/batch";
import { echo } from "jsr:@mityu/lspoints-toolkit@0.1.2/echo";
import * as LSP from "npm:vscode-languageserver-protocol@^3.17.5";
import * as fn from "jsr:@denops/std@^7.1.0/function";
import { BaseExtension, type Lspoints } from "jsr:@kuuote/lspoints@^0.1.1";
import {
  openPreviewPopup,
  type PreviewPopup,
} from "jsr:@mityu/lspoints-toolkit@^0.1.2/popup";
import {
  getMarkupText,
  TextAttrItem,
  textAttrTypes,
} from "jsr:@mityu/lspoints-toolkit@^0.1.2/markup-text";
import * as textprop from "jsr:@mityu/lspoints-toolkit@^0.1.2/textprop";
import {
  HighlightParam,
  setHighlights,
} from "jsr:@mityu/lspoints-toolkit@^0.1.2/highlight";
import { deadline } from "jsr:@std/async@^1.0.0";
import { assert } from "jsr:@core/unknownutil@4.3.0/assert";
import { ensure } from "jsr:@core/unknownutil@4.3.0/ensure";
import { is } from "jsr:@core/unknownutil@4.3.0/is";
import { getCursor } from "jsr:@uga-rosa/denops-lsputil@^0.10.0/cursor";
import { uriFromBufnr } from "jsr:@uga-rosa/denops-lsputil@^0.10.0";

function capitalize(s: string): string {
  return s.slice(0, 1).toUpperCase() + s.slice(1);
}

async function requestHover(
  denops: Denops,
  lspoints: Lspoints,
  bufnr: number,
  timeout: number,
): Promise<LSP.Hover | null> {
  const clients = lspoints.getClients(bufnr);
  if (clients.length === 0) {
    const bufname = await fn.bufname(denops, bufnr);
    await echo(
      denops,
      `No client is attached to buffer: "${bufname}" (bufnr: ${bufnr})`,
      { highlight: "WarningMsg" },
    );
    return null;
  }
  const providerClients = clients.filter((c) => {
    const provider = c.serverCapabilities.hoverProvider;
    if (is.Nullish(provider)) {
      return false;
    } else if (is.Boolean(provider)) {
      return provider;
    } else {
      return provider.workDoneProgress;
    }
  });
  if (providerClients.length === 0) {
    await echo(
      denops,
      `Hover is not supported: ${clients.map((c) => c.name).toString()}`,
    );
    return null;
  }
  const client = providerClients[0];

  const promise = lspoints.request(
    client.name,
    "textDocument/hover",
    {
      textDocument: {
        uri: await uriFromBufnr(denops, bufnr),
      },
      position: await getCursor(denops),
    },
  ) as Promise<LSP.Hover | null>;
  return deadline(promise, timeout)
    .catch(async () => {
      await echo(denops, "Hover: Request timeout");
      return null;
    });
}

async function defineDefaultHighlights(denops: Denops) {
  const highlights = [
    { name: "LspointsHoverMarkupBold", term: { bold: true } },
    { name: "LspointsHoverMarkupItalic", term: { italic: true } },
    { name: "LspointsHoverMarkupStrike", term: { strikethrough: true } },
    { name: "LspointsHoverMarkupUnderlined", term: { underline: true } },
    { name: "LspointsHoverMarkupHorizontalrule", linksto: "Normal" },
    { name: "LspointsHoverMarkupTitle", linksto: "Title" },
    { name: "LspointsHoverMarkupUrl", linksto: "Number" },
    {
      name: "LspointsHoverMarkupLink",
      linksto: "LspointsHoverMarkupUnderlined",
    },
    {
      name: "LspointsHoverMarkupCodespan",
      linksto: "LspointsHoverMarkupItalic",
    },
    { name: "LspointsHoverMarkupCodespanDelimiter", linksto: "Special" },
  ] satisfies HighlightParam[];
  await setHighlights(
    denops,
    highlights.map((v) => {
      return { ...v, default: true };
    }),
  );
}

async function addHighlights(
  denops: Denops,
  bufnr: number,
  highlights: [type: string, highlight: textprop.Highlight][],
) {
  const r = {} as Record<string, textprop.Highlight[]>;
  highlights.forEach((hl) => {
    const type = hl[0];
    r[type] = r[type] ?? [];
    r[type].push(hl[1]);
  });
  await batch(denops, async (denops) => {
    for (const [type, hls] of Object.entries(r)) {
      await textprop.addHighlights(denops, bufnr, type, hls);
    }
  });
}

async function decorateBuffer(
  denops: Denops,
  buffer: { winid: number; bufnr: number },
  attrs: TextAttrItem[],
) {
  const execute = async (cmd: string) =>
    await fn.win_execute(denops, buffer.winid, cmd);

  const propTypes = textAttrTypes
    .filter((type) => type !== "fenced")
    .map((type) => {
      const name = `lspoints.extension.hover.markup.${type}`;
      const highlight = `LspointsHoverMarkup${capitalize(type)}`;
      return {
        name: name,
        highlight: highlight,
      } satisfies textprop.TextPropTypeConfig;
    });
  propTypes.push({
    name: "lspoints.extension.hover.markup.hr",
    highlight: "Normal",
  });

  const validFiletypes = ensure(
    await fn.getcompletion(denops, "", "filetype"),
    is.ArrayOf(is.String),
  );

  const propHighlights = [] as [string, textprop.Highlight][];
  const hrLines = [] as number[];
  const fenced = {} as Record<string, LSP.Range[]>;
  attrs.forEach((attr) => {
    if (attr.type === "fenced") {
      if (validFiletypes.indexOf(attr.lang) !== -1) {
        fenced[attr.lang] = fenced[attr.lang] ?? [];
        fenced[attr.lang].push(attr.range);
      }
    } else if (attr.type === "horizontalrule") {
      hrLines.push(attr.line);
    } else {
      const type = `lspoints.extension.hover.markup.${attr.type}`;
      propHighlights.push([type, attr.range]);
    }
  });

  const layout = ensure(
    await denops.eval(
      [
        `getwininfo(${buffer.winid})[0]`,
        "->filter({k, v -> k =~# '\\v^%(width|textoff)$'})",
      ].join(""),
    ),
    is.ObjectOf({ width: is.Number, textoff: is.Number }),
  );

  await batch(denops, async (denops) => {
    await textprop.addTypes(denops, propTypes);

    await addHighlights(denops, buffer.bufnr, propHighlights);

    const hrText = "─".repeat(layout.width - layout.textoff); // TODO: Check ambiwidth
    textprop.addVirtualTexts(
      denops,
      buffer.bufnr,
      "lspoints.extension.hover.markup.hr",
      hrLines.map((line) => {
        return {
          line,
          column: 1,
          text: hrText,
          textWrap: "truncate",
        };
      }),
    );

    for (const [filetype, ranges] of Object.entries(fenced)) {
      const syngroup = `LspointsHoverMarkdownHighlight${capitalize(filetype)}`;
      await execute("unlet! b:current_syntax");
      await execute(
        `silent! syntax include @${syngroup} syntax/${filetype}.vim`,
      );

      for (const range of ranges) {
        const terms = [] as string[];
        terms.push("syntax", "region", syngroup, "keepend");
        terms.push(
          `start=/\\%${range.start.line}l\\%${range.start.character}c/`,
        );
        terms.push(`end=/.\\%${range.end.line}l\\%${range.end.character}c/`);
        terms.push(`contains=@${syngroup}`);
        terms.push(`containedin=ALL`);
        await execute(terms.join(" "));
      }
    }

    await denops.redraw();
  });
}

export class Extension extends BaseExtension {
  #popup?: PreviewPopup;

  async initialize(denops: Denops, lspoints: Lspoints) {
    await defineDefaultHighlights(denops);

    lspoints.defineCommands("hover", {
      float: async (timeout = 5000) => {
        assert(timeout, is.Number);
        this.#popup?.close();

        const result = await requestHover(
          denops,
          lspoints,
          await fn.bufnr(denops),
          timeout,
        );

        if (is.Null(result)) {
          return;
        }

        const { text, attrs } = getMarkupText(result.contents);

        this.#popup = await openPreviewPopup(denops, {
          contents: text,
          line: -1,
          col: 0,
          pos: "botleft",
          moved: "any",
          border: "double",
        });

        await decorateBuffer(denops, {
          winid: this.#popup.winId,
          bufnr: this.#popup.bufnr,
        }, attrs);
      },
      preview: async (timeout = 5000) => {
        // TODO: support cmdmods
        assert(timeout, is.Number);
        this.#popup?.close();

        const result = await requestHover(
          denops,
          lspoints,
          await fn.bufnr(denops),
          timeout,
        );

        if (is.Null(result)) {
          return;
        }
        const { text, attrs } = getMarkupText(result.contents);

        await denops.cmd("silent! pedit lspoints://hover");
        const bufnr = await fn.bufnr(denops, "lspoints://hover");
        const winid = await fn.bufwinid(denops, bufnr);

        await batch(denops, async (denops) => {
          await fn.setbufvar(denops, bufnr, "&buftype", "nofile");
          await fn.setbufvar(denops, bufnr, "&bufhidden", "delete");
          await fn.deletebufline(denops, bufnr, 1, "$");
          await fn.setbufline(denops, bufnr, 1, text);
          // await fn.cursor(denops, 1, 1);
          await fn.win_execute(denops, winid, "call cursor(1, 1)");
        });
        await decorateBuffer(denops, {
          winid: winid,
          bufnr: bufnr,
        }, attrs);
        await denops.redraw();
      },
    });
  }

  clientCapabilities(): LSP.ClientCapabilities {
    return {
      textDocument: {
        hover: {
          dynamicRegistration: false,
          contentFormat: [LSP.MarkupKind.Markdown, LSP.MarkupKind.PlainText],
        },
      },
    };
  }
}
