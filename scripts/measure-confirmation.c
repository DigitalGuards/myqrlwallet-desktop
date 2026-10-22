/* Test-only N-API probe. Read the live GTK/Pango allocations in Electron's
 * main thread. No widget size, font, content, position or behavior is changed.
 * Dynamic symbols keep this probe independent of GTK development headers. */
#include <dlfcn.h>
#include <node_api.h>
typedef struct List {
  void *data;
  struct List *next, *prev;
} List;
typedef struct {
  int x, y, width, height;
} Rect;
#define FN(ret, name, args) static ret(*name) args
FN(List *, gtk_window_list_toplevels, (void));
FN(int, gtk_widget_get_visible, (void *));
FN(unsigned long, gtk_message_dialog_get_type, (void));
FN(unsigned long, gtk_label_get_type, (void));
FN(unsigned long, gtk_button_get_type, (void));
FN(void *, pango_layout_get_context, (void *));
FN(void *, pango_context_get_font_description, (void *));
FN(char *, pango_font_description_to_string, (void *));
FN(double, pango_cairo_context_get_resolution, (void *));
FN(void, g_free, (void *));
FN(unsigned long, gtk_container_get_type, (void));
FN(int, g_type_check_instance_is_a, (void *, unsigned long));
FN(List *, gtk_container_get_children, (void *));
FN(void, g_list_free, (List *));
FN(void *, gtk_widget_get_window, (void *));
FN(int, gdk_window_get_origin, (void *, int *, int *));
FN(void, gtk_window_get_size, (void *, int *, int *));
FN(int, gtk_widget_translate_coordinates,
   (void *, void *, int, int, int *, int *));
FN(void, gtk_widget_get_allocation, (void *, Rect *));
FN(void, gtk_label_get_layout_offsets, (void *, int *, int *));
FN(void *, gtk_label_get_layout, (void *));
FN(const char *, gtk_label_get_text, (void *));
FN(void *, pango_layout_get_iter, (void *));
FN(int, pango_layout_iter_get_index, (void *));
FN(void, pango_layout_iter_get_line_extents, (void *, Rect *, Rect *));
FN(int, pango_layout_iter_next_line, (void *));
FN(void, pango_layout_iter_free, (void *));
static napi_value obj(napi_env e) {
  napi_value v;
  napi_create_object(e, &v);
  return v;
}
static void number(napi_env e, napi_value o, const char *k, double n) {
  napi_value v;
  napi_create_double(e, n, &v);
  napi_set_named_property(e, o, k, v);
}
static void string(napi_env e, napi_value o, const char *k, const char *s) {
  napi_value v;
  napi_create_string_utf8(e, s, NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(e, o, k, v);
}
static napi_value bounds(napi_env e, void *w, void *top, int x, int y) {
  int ox = 0, oy = 0;
  Rect r;
  gtk_widget_translate_coordinates(w, top, 0, 0, &ox, &oy);
  gtk_widget_get_allocation(w, &r);
  napi_value o = obj(e);
  number(e, o, "x", x + ox);
  number(e, o, "y", y + oy);
  number(e, o, "width", r.width);
  number(e, o, "height", r.height);
  return o;
}
static void labels(napi_env e, void *w, void *top, int x, int y, napi_value a,
                   unsigned *count, napi_value buttons, unsigned *button_count) {
  if (g_type_check_instance_is_a(w, gtk_button_get_type()) && gtk_widget_get_visible(w))
    napi_set_element(e, buttons, (*button_count)++, bounds(e, w, top, x, y));
  if (g_type_check_instance_is_a(w, gtk_label_get_type()) &&
      gtk_widget_get_visible(w)) {
    const char *text = gtk_label_get_text(w);
    int ox = 0, oy = 0, lx = 0, ly = 0;
    gtk_widget_translate_coordinates(w, top, 0, 0, &ox, &oy);
    gtk_label_get_layout_offsets(w, &lx, &ly);
    Rect allocation;
    gtk_widget_get_allocation(w, &allocation);
    /* GTK label offsets include the allocation for these windowless widgets.
     * translate_coordinates already includes it; count it once. */
    lx -= allocation.x;
    ly -= allocation.y;
    napi_value label = obj(e), lines;
    napi_create_array(e, &lines);
    string(e, label, "text", text);
    napi_set_named_property(e, label, "allocation", bounds(e, w, top, x, y));
    void *context = pango_layout_get_context(gtk_label_get_layout(w));
    char *font = pango_font_description_to_string(pango_context_get_font_description(context));
    string(e, label, "font", font);
    g_free(font);
    number(e, label, "dpi", pango_cairo_context_get_resolution(context));
    void *iter = pango_layout_get_iter(gtk_label_get_layout(w));
    unsigned i = 0;
    do {
      Rect r;
      pango_layout_iter_get_line_extents(iter, NULL, &r);
      napi_value line = obj(e);
      number(e, line, "byte", pango_layout_iter_get_index(iter));
      number(e, line, "x", x + ox + lx + r.x / 1024.0);
      number(e, line, "y", y + oy + ly + r.y / 1024.0);
      number(e, line, "width", r.width / 1024.0);
      number(e, line, "height", r.height / 1024.0);
      napi_set_element(e, lines, i++, line);
    } while (pango_layout_iter_next_line(iter));
    pango_layout_iter_free(iter);
    napi_set_named_property(e, label, "lines", lines);
    napi_set_element(e, a, (*count)++, label);
  }
  if (g_type_check_instance_is_a(w, gtk_container_get_type())) {
    List *l = gtk_container_get_children(w);
    for (List *p = l; p; p = p->next)
      labels(e, p->data, top, x, y, a, count, buttons, button_count);
    g_list_free(l);
  }
}
static napi_value measure(napi_env e, napi_callback_info info) {
  (void)info;
  napi_value a;
  napi_create_array(e, &a);
  unsigned n = 0;
  List *l = gtk_window_list_toplevels();
  for (List *p = l; p; p = p->next) {
    void *w = p->data;
    if (!gtk_widget_get_visible(w) ||
        !g_type_check_instance_is_a(w, gtk_message_dialog_get_type()))
      continue;
    int x = 0, y = 0, width = 0, height = 0;
    gdk_window_get_origin(gtk_widget_get_window(w), &x, &y);
    gtk_window_get_size(w, &width, &height);
    napi_value o = obj(e), ls, buttons;
    napi_create_array(e, &buttons);
    napi_create_array(e, &ls);
    unsigned count = 0, button_count = 0;
    labels(e, w, w, x, y, ls, &count, buttons, &button_count);
    number(e, o, "x", x);
    number(e, o, "y", y);
    number(e, o, "width", width);
    number(e, o, "height", height);
    napi_set_named_property(e, o, "labels", ls);
    napi_set_named_property(e, o, "buttons", buttons);
    napi_set_element(e, a, n++, o);
  }
  g_list_free(l);
  return a;
}
napi_value napi_register_module_v1(napi_env e, napi_value exports) {
  void *h = dlopen("libgtk-3.so.0", RTLD_NOW | RTLD_NOLOAD);
  if (!h) {
    napi_throw_error(e, NULL, "GTK is not loaded");
    return exports;
  }
#define LOAD(name)                                                             \
  do {                                                                         \
    name = dlsym(h, #name);                                                    \
    if (!name) {                                                               \
      napi_throw_error(e, NULL, #name);                                        \
      return exports;                                                          \
    }                                                                          \
  } while (0)
  LOAD(gtk_window_list_toplevels);
  LOAD(gtk_widget_get_visible);
  LOAD(gtk_message_dialog_get_type);
  LOAD(gtk_label_get_type);
  LOAD(gtk_button_get_type);
  LOAD(pango_layout_get_context);
  LOAD(pango_context_get_font_description);
  LOAD(pango_font_description_to_string);
  LOAD(pango_cairo_context_get_resolution);
  LOAD(g_free);
  LOAD(gtk_container_get_type);
  LOAD(g_type_check_instance_is_a);
  LOAD(gtk_container_get_children);
  LOAD(g_list_free);
  LOAD(gtk_widget_get_window);
  LOAD(gdk_window_get_origin);
  LOAD(gtk_window_get_size);
  LOAD(gtk_widget_translate_coordinates);
  LOAD(gtk_widget_get_allocation);
  LOAD(gtk_label_get_layout_offsets);
  LOAD(gtk_label_get_layout);
  LOAD(gtk_label_get_text);
  LOAD(pango_layout_get_iter);
  LOAD(pango_layout_iter_get_index);
  LOAD(pango_layout_iter_get_line_extents);
  LOAD(pango_layout_iter_next_line);
  LOAD(pango_layout_iter_free);
  napi_value f;
  napi_create_function(e, "measure", NAPI_AUTO_LENGTH, measure, NULL, &f);
  napi_set_named_property(e, exports, "measure", f);
  return exports;
}
