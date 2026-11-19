# MotoTrips

Webapp voor motorrijders: genereer bochtige routes (rondje of van A naar B) op basis van afstand of tijd, en rij ze met turn-by-turn spraaknavigatie. Installeerbaar op je telefoon (PWA).

## Functies

- **Rondje of A → B**: zoek een adres, gebruik je huidige locatie of tik op de kaart.
- **Afstand of tijd**: rondjes van 20–500 km of 30 min – 10 uur. Bij A → B kun je kiezen hoeveel je wilt omrijden.
- **Bochten**: rustig, wat bochten, bochtig of zo veel mogelijk bochten. De app maakt meerdere varianten, meet de bochtigheid per km en zet de beste bovenaan (met bochtsterren).
- **Soort wegen**: schuif tussen binnenweggetjes en 80-wegen (N-wegen). Snelwegen, tol en veerponten vermijden, en optioneel onverhard toestaan.
- **Navigatie**: grote afslagpijlen, afstand tot de afslag, gesproken Nederlandse aanwijzingen, resterende tijd/afstand, aankomsttijd, snelheid. Als je van de route afrijdt, berekent hij automatisch een nieuwe route (en houdt hij de rest van je rondje aan). Het scherm blijft aan tijdens het rijden.
- **Demo-rit**: rij virtueel over de route om de navigatie zonder GPS te testen.
- **GPX-export** voor Garmin, TomTom Rider, Calimoto, enzovoort.
- **Bewaren**: routes opslaan op je toestel.

## Starten

```bash
npm install
npm run dev
```

Open daarna http://localhost:5173.

## Op je telefoon gebruiken

GPS werkt in de browser alleen via **https** (of localhost). Zet de app daarom online, bijvoorbeeld gratis via Netlify, Vercel, Cloudflare Pages of GitHub Pages:

```bash
npm run build
```

Upload de map `dist/`. Open de site op je telefoon en kies **Zet op beginscherm** (iPhone: deelknop, Android: menu) om hem als app te installeren.

Tips voor onderweg:
- Koppel je telefoon via Bluetooth aan je helm-intercom voor de gesproken aanwijzingen.
- Laat de app op de voorgrond staan: browsers geven op de achtergrond geen GPS door.

## Hoe het werkt

| Onderdeel | Dienst |
|---|---|
| Kaart | [OpenFreeMap](https://openfreemap.org) via MapLibre GL |
| Routes en instructies | [Valhalla](https://valhalla.github.io/valhalla/) (motorprofiel), publieke server van FOSSGIS |
| Adressen zoeken | [Photon](https://photon.komoot.io) |

Alles is gratis en zonder API-sleutel. De publieke Valhalla-server is bedoeld voor licht gebruik. Bij veel gebruikers kun je een eigen Valhalla-server draaien en die bij **Instellingen → Routeserver** invullen.

Code-overzicht:
- `src/lib/generator.ts`: maakt routevarianten (rondjes via punten op een cirkel, A → B via zijwaartse tussenpunten), corrigeert naar de gewenste afstand/tijd en beoordeelt bochtigheid, overlap en keerpunten.
- `src/lib/navigator.ts`: koppelt GPS aan de route, bepaalt de volgende afslag, timet de spraakaanwijzingen op je snelheid en herberekent bij afwijken.
- `src/lib/valhalla.ts`: routeringsclient met de motorvoorkeuren.

Let op: controleer onderweg altijd zelf de verkeersborden en de situatie op de weg.
