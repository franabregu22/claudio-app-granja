# Ponytail Configuration for Claude Code

## What is Ponytail?

Ponytail is a skill that makes Claude Code write like a lazy senior dev:
- **-54% less code**
- **-20% cheaper** (fewer API calls)
- **-27% faster**
- **100% safe**

The philosophy: **The best code is the code you never wrote.**

## How to Use

When Claude Code suggests a solution with unnecessary dependencies or over-engineering, Ponytail reminds:

### Examples

#### Date Picker
❌ Without Ponytail:
```typescript
import flatpickr from "flatpickr";
import "flatpickr/dist/flatpickr.min.css";

export function DatePicker() {
  const ref = useRef(null);
  useEffect(() => {
    flatpickr(ref.current, { mode: "range" });
  }, []);
  return <input ref={ref} />;
}
```

✅ With Ponytail:
```html
<!-- ponytail: browser has one -->
<input type="date">
```

#### Color Picker
❌ Before: 287 lines of custom component
✅ After: `<input type="color">`

#### Validation
❌ Before: Install yup/zod + wrapper
✅ After: HTML5 validation + `required`, `pattern`, `minLength`

## For this Project (Claudio app Granja)

### Already Using Ponytail Patterns:
- ✅ Input validation with Zod (good balance)
- ✅ RLS instead of app-level auth checks
- ✅ Native HTML form elements
- ✅ Tailwind instead of component libraries

### Where to Apply Ponytail:
1. **Forms** - Use native `<input>` attributes before custom validation
2. **Date pickers** - `<input type="date">` works perfect for `fecha_operacion`
3. **Dropdowns** - `<select>` before reaching for custom components
4. **Error messages** - HTML5 validation before custom error UI
5. **Modals** - `<dialog>` element (native, no lib needed)

### Remember:
- Every dependency costs money (bundle size + API calls)
- Every line of code is a bug waiting to happen
- Native browser APIs are battle-tested by billions
- Simple > Complex. Ship > Perfect.

## Principle

When proposing new features or fixes:
1. ✅ Does native HTML do this? Use it.
2. ✅ Does Tailwind style this? Use it.
3. ✅ Does your existing stack provide it? Use it.
4. ❌ Only reach for new libraries if #1-3 fail.

---

**Ponytail installed:** `npm list @dietrichgebert/ponytail`
**GitHub:** https://github.com/DietrichGebert/ponytail
