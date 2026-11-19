# MotoTrips

Webapp voor motorrijders: genereer bochtige routes (rondje of van A naar B) op basis van afstand of tijd, en rij ze met turn-by-turn spraaknavigatie. Installeerbaar op je telefoon (PWA).

**Online:** https://teamelastiek.github.io/mototrips/

## Functies

### Plannen
- **Rondje of A → B**: zoek een adres, gebruik je huidige locatie of tik op de kaart.
- **Afstand of tijd**: rondjes van 20–500 km of 30 min – 10 uur. Bij A → B kies je zelf hoeveel je wilt omrijden.
- **Bochten**: rustig, wat bochten, bochtig of zo veel mogelijk bochten. De app maakt meerdere varianten, meet de bochtigheid per km en zet de beste bovenaan (met bochtsterren).
- **Soort wegen**: schuif tussen binnenweggetjes en 80-wegen (N-wegen). Snelwegen, tol en veerponten vermijden, optioneel onverhard toestaan.
- **Steden vermijden**: tussenpunten blijven buiten steden en grote dorpen, en routes door bebouwd gebied scoren lager.
- **Ontdek nieuwe wegen**: de app onthoudt welke wegen je met navigatie gereden hebt en kiest liever wegen die je nog niet kent (met "% nieuw" per variant).
- **Route aanpassen**: tik op de kaart om een tussenpunt toe te voegen, sleep een punt naar een andere weg, of tik erop om het te verwijderen.
- **GPX openen**: laad een route of spoor van een motorclub, forum of Garmin. Een spoor wordt aan de weg gekoppeld, zodat je hem met afslag-aanwijzingen kunt rijden.

### Per route
- **Weer onderweg**: verwachting op elk stuk van de route op het moment dat je daar rijdt, met waarschuwing voor regen, harde wind en kou. De vertrektijd kun je aanpassen.
- **Zonsondergang**: waarschuwing als je (deels) in het donker rijdt.
- **Hoogteprofiel**: grafiek met klimmen, dalen en het hoogste punt.
- **Tanken**: stel je tankbereik in. Bij langere routes stelt de app tankstations langs de route voor.
- **Pauzeplek**: cafés en restaurants rond de helft van je rit. Met één tik voeg je ze als stop toe.
- **Delen**: stuur een link (via het deelmenu of gekopieerd). Wie hem opent, krijgt precies dezelfde route.
- **Offline kaart**: download de kaart rond de route voor gebieden zonder bereik.
- **GPX-export** voor Garmin, TomTom Rider, Calimoto, enzovoort, en **bewaren** op je toestel.

### Navigatie
- Grote afslagpijlen, afstand tot de afslag en gesproken Nederlandse aanwijzingen.
- Resterende tijd en afstand, aankomsttijd en snelheid.
- **Maximumsnelheid** van de weg waar je rijdt, met een piepje en rode snelheidsmeter als je te hard gaat.
- **Volgende tankstation** onderweg.
- Automatisch herberekenen als je van de route afrijdt; de rest van je rondje blijft behouden.
- Het scherm blijft aan; 's avonds wordt de kaart automatisch donker.
- **Demo-rit** om zonder GPS te testen.

### Ritlogboek
- Elke rit met navigatie wordt opgenomen: afstand, rijtijd, gemiddelde en maximale snelheid en **geschatte maximale hellingshoek** (links/rechts).
- Totalen over al je ritten, het gereden spoor op de kaart en GPX-export.

## Starten

```bash
npm install
npm run dev
```

Open daarna http://localhost:5173.

## Publiceren

Elke push naar `main` zet de app via GitHub Actions automatisch op GitHub Pages. Op Windows kun je dubbelklikken op `push.bat`.

Tips voor onderweg:
- Koppel je telefoon via Bluetooth aan je helm-intercom voor de gesproken aanwijzingen.
- Laat de app op de voorgrond staan: browsers geven op de achtergrond geen GPS door.

## Gebruikte diensten (gratis, zonder sleutel)

| Onderdeel | Dienst |
|---|---|
| Kaart | [OpenFreeMap](https://openfreemap.org) via MapLibre GL |
| Routes, instructies, hoogtes, maximumsnelheden | [Valhalla](https://valhalla.github.io/valhalla/) (motorprofiel), publieke server van FOSSGIS |
| Adressen zoeken | [Photon](https://photon.komoot.io) |
| Tankstations, cafés, steden | [Overpass API](https://overpass-api.de) (OpenStreetMap) |
| Weer | [Open-Meteo](https://open-meteo.com) |

De publieke servers zijn bedoeld voor licht gebruik en zijn soms even overbelast. De app probeert dan andere servers en anders kun je het later opnieuw proberen. Bij veel gebruikers kun je een eigen Valhalla-server draaien en die bij **Instellingen → Routeserver** invullen.

## Code-overzicht

| Bestand | Wat |
|---|---|
| `src/lib/generator.ts` | Routevarianten maken en beoordelen (bochten, overlap, steden, nieuwe wegen) |
| `src/lib/navigator.ts` | GPS koppelen aan de route, aanwijzingen timen, herberekenen, maximumsnelheid |
| `src/lib/valhalla.ts` | Routering, GPX-koppeling, hoogteprofiel, maximumsnelheden |
| `src/lib/logbook.ts` | Ritten opnemen, hellingshoek schatten, gereden wegen onthouden |
| `src/lib/overpass.ts` | Tankstations, cafés en steden langs de route |
| `src/lib/weather.ts` | Weer langs de route |
| `src/lib/offline.ts` + `public/sw.js` | Offline kaarttegels |
| `src/lib/share.ts` | Deel-links |
| `src/lib/gpxImport.ts` / `gpx.ts` | GPX inlezen en exporteren |
| `src/lib/sun.ts` | Zonsopkomst/-ondergang (nachtmodus) |

Let op: controleer onderweg altijd zelf de verkeersborden en de situatie op de weg.
