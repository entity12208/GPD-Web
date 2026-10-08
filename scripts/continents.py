"""Continent assignment by ISO 3166-1 alpha-2 code (or name for '-99' features).

The bundled GeoJSON carries no continent property, so the web edition assigns
one here. Continent names match constants.CONT_VALUES in the Python game.
"""

_GROUPS = {
    "Europe": "AD AL AT AX BA BE BG BY CH CZ DE DK EE ES FI FO GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL PL PT RO RS RU SE SI SK SM UA VA "
              "France Norway Kosovo",
    "Asia": "AE AF AM AZ BD BH BN BT CN CY GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR UZ VN YE CN-TW IO "
            "Dhekelia_Sovereign_Base_Area Northern_Cyprus Cyprus_No_Mans_Area Siachen_Glacier Baykonur_Cosmodrome Akrotiri_Sovereign_Base_Area Spratly_Islands Scarborough_Reef Indian_Ocean_Territories",
    "Africa": "AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG ZA ZM ZW "
              "Somaliland Bir_Tawil",
    "North America": "US CA MX GL PM BM",
    "Central America": "BZ CR GT HN NI PA SV CU DO HT JM BS TC KY PR VI VG AI AG KN MS DM LC VC BB GD TT AW CW SX MF BL "
                       "US_Naval_Base_Guantanamo_Bay Bajo_Nuevo_Bank_(Petrel_Is.) Serranilla_Bank Clipperton_Island",
    "South America": "AR BO BR CL CO EC GY PE PY SR UY VE FK GS "
                     "Brazilian_Island Southern_Patagonian_Ice_Field",
    "Antarctica": "AQ TF HM",
}

CONTINENT_BY_ISO = {}
for _cont, _codes in _GROUPS.items():
    for _code in _codes.split():
        CONTINENT_BY_ISO[_code] = _cont
        CONTINENT_BY_ISO[_code.replace("_", " ")] = _cont
# Everything else (Australia, Pacific islands, ...) falls back to "Oceania".
