# Inviter — jednoduchý nástroj pro rychlé pozvání

Jednoduché doplňkové rozšíření, které prochází tlačítka "Pozvat" ve Facebook seznamu reakcí, posouvá je do zobrazení a kliká na ně postupně.

## 🔧 Použití

1. Otevřete příspěvek na Facebooku a klikněte na počet reakcí, aby se otevřel seznam reakcí.
2. Otevřete rozšíření (popup) a stiskněte tlačítko **Start**.
3. Skript posouvá každé tlačítko do středu obrazovky a klikne na něj s náhodným zpožděním (2–5 s).

## ⚙️ Konfigurace

-   Selektor tlačítek najdete v `popup.js`:

```js
// např. změňte pokud máte jiný jazyk Facebooku
document.querySelectorAll('div[aria-label="Pozvat"]');
```

-   Pokud Facebook používá jiný jazyk, upravte text v selektoru (např. "Invite", "Pozvat").

## ❗ Upozornění

-   Používejte zodpovědně a respektujte zásady Facebooku (Terms of Service).
-   Tento skript může být detekován jako automatizace; používejte na vlastní riziko.

## 🛠️ Kde upravovat

-   Hlavní logika je v `popup.js` — změny v selektoru, rychlosti nebo textu hlášení zde proveďte přímo.

## Kontakt

-   Chcete-li změny lokalizace, limity nebo další funkce (pauza, stop, limit pozvánek), napište a já je doplním.

---

_Vytvořeno rychle pro osobní použití._
