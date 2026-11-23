import { View, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { setShared, shared, theme } from "herdr";

// The Services dialog: what the server's dashboard lists, as cards with the service's icon, its
// state and its links. The data and the refreshing belong to the services-button mod, which is
// always on screen.

const KEY_DATA = "services.data";
const KEY_REFRESH = "services.refresh";
const KEY_CURRENT = "services.current";
const ICONS = "mods/services/icons";
const ORDER = ["Development", "Applications", "AI", "Infrastructure", "Management"];
const CATEGORY_GLYPH = { Infrastructure: "network", Management: "desktop" };

const STATE = {
  up: ["Online", "ansi2"],
  down: ["Offline", "ansi1"],
  local: ["Server only", "ansi3"],
  unknown: ["Unknown", "dim"],
};

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
}

/** The same project keeps the same colour. */
function hue(name, t) {
  const palette = [t.ansi1, t.ansi2, t.ansi3, t.ansi4, t.ansi5, t.ansi6];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

/** The service's logo, a glyph for its kind, or its first letter in the project's colour. */
function tile(t, item) {
  const box = h_flex().flex_none().size(38).rounded(10).items_center().justify_center().bg(t.surface).border_1().border_color(t.border);
  if (item.logo) return box.child(image(item.logo).size(24));
  const glyph = item.glyph ?? (CATEGORY_GLYPH[item.category] ? `${ICONS}/${CATEGORY_GLYPH[item.category]}.svg` : null);
  if (glyph) return box.child(svg(glyph).size(20).text_color(t.accent));
  return box.text_size(16).font_semibold().text_color(hue(item.name, t)).child(item.name.slice(0, 1).toUpperCase());
}

function pill(t, text, colour) {
  return h_flex().flex_none().items_center().gap(5).px(8).py(2).rounded(10).border_1().border_color(colour)
    .text_size(10.5).text_color(colour)
    .child(h_flex().size(6).rounded(3).bg(colour))
    .child(text);
}

export default class Services extends View {
  render() {
    const t = theme();
    const data = shared(KEY_DATA);
    const current = shared(KEY_CURRENT);
    const items = data?.items ?? [];
    const groups = new Map();
    for (const i of items) groups.set(i.category, [...(groups.get(i.category) ?? []), i]);
    const cats = [...groups.keys()].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
    const count = (s) => items.filter((i) => i.status === s).length;
    const now = items.find((i) => i.key === current);

    const card = (i) => {
      const [text, tone] = STATE[i.status];
      const mine = i.key === current;
      return h_flex().id(`row-${i.key}`).px(12).py(10).gap(12).items_center().rounded(12).bg(t.raised).border_1()
        .border_color(mine ? t.accent : t.border).hover((s) => s.border_color(t.input))
        .child(tile(t, i))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().gap(8).items_center()
            .child(v_flex().min_w(0).truncate().font_semibold().text_size(13.5).text_color(t.foreground).child(i.name))
            .when(!!i.port, (el) => el.child(v_flex().flex_none().text_size(11).text_color(t.dim).child(`:${i.port}`)))
            .when(mine, (el) => el.child(pill(t, "This conversation", t.accent))))
          .child(v_flex().min_w(0).truncate().text_size(11).text_color(t.muted).child(i.desc ?? "")))
        .child(pill(t, text, t[tone]))
        .children(i.links.map((l, n) => h_flex().id(`l-${i.key}-${n}`).flex_none().px(10).py(5).rounded(7).bg(t.solid)
          .text_size(11.5).text_color(t.solid_foreground).font_semibold().cursor_pointer().hover((s) => s.opacity(0.85))
          .on_click((_e, cx) => cx.open_url(l.url)).child(`${l.label.replace(/ \(this machine only\)/, "")} ↗`)));
    };

    const chip = (text, colour) => h_flex().items_center().gap(5).px(9).py(3).rounded(10).bg(t.raised).text_size(11.5).text_color(t.muted)
      .child(h_flex().size(7).rounded(4).bg(colour)).child(text);

    return v_flex().size_full().p(18).gap(14).bg(t.popover).text_size(13).text_color(t.foreground)
      .child(h_flex().items_center().gap(12)
        .child(svg(`${ICONS}/generic.svg`).size(22).text_color(t.accent))
        .child(v_flex().flex_1().gap(1)
          .child(v_flex().text_size(17).font_semibold().child("Services"))
          .child(v_flex().text_size(11).text_color(t.dim).child(data ? `${data.ip || "server"} · updated ${ago(data.at)}` : "Loading…")))
        .child(chip(`${count("up")} online`, t.ansi2))
        .when(count("down") > 0, (el) => el.child(chip(`${count("down")} offline`, t.ansi1)))
        .child(h_flex().id("svc-refresh").px(11).py(5).rounded(8).border_1().border_color(t.border).text_size(12).text_color(t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => setShared(KEY_REFRESH, Date.now())).child("Refresh")))
      .when(!!now, (el) => el.child(h_flex().items_center().gap(10).px(12).py(8).rounded(10).border_1().border_color(t.accent).text_size(12)
        .child(tile(t, now).size(26)).child(v_flex().flex_1().child(`This conversation is about ${now.name}${now.port ? ` (:${now.port})` : ""}`))))
      .when(!!data?.error, (el) => el.child(v_flex().text_size(12).text_color(t.blocked).child(`Showing the last list. ${data.error}`)))
      .child(v_flex().id("svc-list").flex_1().min_h(0).overflow_y_scrollbar().gap(16)
        .children(cats.map((c) => v_flex().gap(6)
          .child(h_flex().px(4).gap(8).items_center().text_size(10.5).text_color(t.muted).font_semibold()
            .child(c.toUpperCase()).child(v_flex().text_color(t.dim).child(String(groups.get(c).length))))
          .children(groups.get(c).map(card)))));
  }
}
