# -*- coding: utf-8 -*-
import re, itertools, json
import os
CTX = open(os.path.join(os.path.dirname(__file__),"..","context.md"), encoding="utf-8").read().lower()

# Cada tópico: required = lista de grupos (AND); cada grupo = lista de sinónimos (OR).
# El bot puede responder bien SOLO si el context.md contiene fundamento para todos los grupos.
TOPICS = [
 ("pricing_roundtrip", [["2,700","2700"]], ["how much is the roundtrip","price of roundtrip","roundtrip cost"]),
 ("pricing_extreme",   [["3,450","3450"]], ["how much is extreme","extreme price","cost of the extreme package"]),
 # 27-jul-2026: exigía 3,950, el precio MUERTO. Pasaba igual porque esa cifra sigue apareciendo en los
 # avisos de "precios viejos" — o sea, el check verde no probaba nada del precio vivo. Ahora exige 3,750.
 ("pricing_deluxe",    [["3,750","3750"]], ["deluxe price","how much is deluxe","cost of deluxe"]),
 ("price_min",         [["2,700","2700"]], ["cheapest option","lowest price","starting price bali komodo"]),
 ("guided_supplement", [["self-guided","self guided"],["550"],["support vehicle","support car"],["meals"]], ["is a guide included","what does the guided option add","can we go without a guide"]),
 ("pillion",           [["pillion"],["380"]], ["my wife rides on the back","two up price","pillion discount"]),
 ("guided_dates",      [["guided"],["november 4","nov 4","fixed"]], ["when are guided departures","guided tour dates","is it a guided tour"]),
 ("guided_future",     [["guided"],["future","not yet","waitlist","form a group","2027","scheduled later"]], ["we want a guided tour in 2027","do you have guided trips next year","guided departure for late 2027"]),
 # El nº de islas DEPENDE de la edición: el Roundtrip da la vuelta en Sumbawa y no llega a Komodo.
 # Este check exige que el contexto lo diga explícitamente — antes exigía "6 islands", que era el error.
 ("islands",           [["roundtrip"],["does not reach","not reach","never reaches","turns around"],["komodo"]], ["how many islands","which islands do you visit","does roundtrip go to komodo"]),
 ("duration",          [["12 day","12-day"]], ["how many days","trip length","how long is the tour"]),
 ("bikes",             [["versys"],["cb 150x","cb150x"]], ["what bikes do you use","which motorcycles","bike options"]),
 ("license_idp",       [["international driving permit","idp"]], ["what license do I need","do I need an international permit","driving licence requirement"]),
 ("age_minors",        [["18"],["minor"]], ["can my 16 year old come","age limit","are kids allowed"]),
 ("insurance_deposit", [["275"],["1,000","1000"]], ["insurance cost","security deposit","damage deposit"]),
 ("cancellation",      [["30 days"],["refund"]], ["cancellation policy","can I get a refund","what if I cancel"]),
 ("installments",      [["instal","payment plan","split"]], ["can I pay in installments","payment plan","split the payment"]),
 ("included",          [["included"],["meals","food"],["guided only","guided supplement"]], ["what is included","does it include meals","whats covered"]),
 ("roads",             [["tarmac","paved","90%"]], ["is it off road","how technical","roads or dirt"]),
 ("ferries",           [["ferry","ferries"]], ["how do you cross islands","ferries with bikes","island transfers"]),
 ("gilis",             [["gili"],["traffic-free","no bikes","boat"]], ["can we ride on gili","gili islands bikes","gili trawangan"]),
 ("airport_inout",     [["ngurah rai","fly in","fly out","denpasar"]], ["which airport","where do we fly into","start and end point"]),
 ("flight_back",       [["internal flight","flight back","fly back"]], ["do we fly back","return flight included","how do we get back from komodo"]),
 ("own_bike",          [["own bike","your own motorcycle","bring my bike"]], ["can I bring my own bike","use my motorcycle","ride my own bike"]),
 ("seven_islands",     [["7 islands","seven islands"],["2,050","2050"]], ["tell me about 7 islands","other tour options","lighter trip"]),
# El 4 Islands cuesta 1.100 USD fijos (subió de los 990 EUR el 27-jul-2026) y NO admite guiado. El check vigila las dos cosas: si alguien
 # borra el "no guided option", el bot volveria a sumarle el suplemento de 550 que no le corresponde.
 ("four_islands",      [["4 islands","4islands"],["1,100"],["no guided option","not just for riders"]], ["tell me about the 4 islands tour","how much is 4 islands","a shorter trip without the gilis"]),
 ("nov4_departure",    [["november 4"],["only"],["550"]], ["when is the guided departure","what dates do you have","is there a group i can join"]),
 ("sumba",             [["sumba"]], ["do you go to sumba","sumba tour","sumba challenge"]),
 ("video_call",        [["video call","30-min","30 min"]], ["can we talk on a call","book a call","speak to the team"]),
 ("deposit_booking",   [["500 per person"],["balance","60 days"]], ["how do I book","deposit to reserve","when is the balance due"]),
 # --- candidatos a HUECO ---
 ("visa",              [["visa"]], ["do I need a visa for indonesia","visa requirements","visa on arrival"]),
 ("travel_insurance",  [["travel insurance"]], ["is travel insurance required","do I need travel insurance","medical insurance needed"]),
 ("best_time",         [["dry season","best time","weather","rainy","wet season","april","may","june","july","august","september"]], ["best time of year to ride","what is the weather like","rainy season"]),
 ("guide_english",     [["english-speaking","english speaking","speaks english"]], ["does the guide speak english","guide language","english guide"]),
 ("dietary",           [["vegetarian","dietary","diet","vegan","halal"]], ["I am vegetarian","dietary requirements","food allergies"]),
 ("airport_transfer",  [["airport transfer","pick you up","transfer from the airport","hotel transfer"]], ["do you pick us up at the airport","airport transfer included","how do I get to the hotel"]),
 ("non_rider",         [["non-rider","does not ride","doesn't ride","passenger","support car seat","companion"]], ["my partner doesn't ride can she come","non riding companion","can a passenger join"]),
 ("rental_only",       [["rental","rent a bike","balibestmotorcycle","sumba.balibestmotorcycle"]], ["I just want to rent a bike","do you rent motorcycles","bike rental only"]),
 ("safety",            [["safe","safety","support car","mechanic"]], ["is it safe","how safe is the trip","what if I break down"]),
 ("fitness",           [["fitness","fit","experience","intermediate"]], ["how fit do I need to be","riding experience needed","is it hard"]),
 ("luggage",           [["luggage","support vehicle","support car","daypack"]], ["how is luggage carried","where does my luggage go","can I bring a suitcase"]),
 ("discount_group",    [["all-inclusive","all inclusive","value","self-guided"]], ["any group discount","can you give a better price","discount for 4 people"]),
 ("human",             [["team","video call","daniel"]], ["are you a bot","can I talk to a real person","is this automated"]),
]

def covered(req):
    for group in req:
        if not any(k in CTX for k in group):
            return False
    return True

# Generar 1000 conversaciones (mensaje cliente) variando persona/idioma/fraseo.
personas = ["", "Hi! ", "Hey mate, ", "Quick question: ", "Hello, ", "Hola, ", "G'day, ", "Hi there, "]
tails = ["", " thanks", " cheers", " 🙏", "?", " please", " just wondering"]
convos = []
ti = 0
while len(convos) < 1000:
    name, req, qs = TOPICS[ti % len(TOPICS)]
    q = qs[(len(convos)//len(TOPICS)) % len(qs)]
    p = personas[len(convos) % len(personas)]
    t = tails[(len(convos)//3) % len(tails)]
    convos.append({"topic": name, "msg": (p + q + t).strip()})
    ti += 1

# Cobertura por tópico
cov = {name: covered(req) for (name, req, qs) in TOPICS}
gaps = [n for n,c in cov.items() if not c]
covered_count = sum(1 for c in cov.values() if c)
tested = {}
for c in convos:
    tested[c["topic"]] = tested.get(c["topic"],0)+1

print("=== SIMULACION QA — 1000 conversaciones ===")
print("Conversaciones generadas:", len(convos))
print("Familias de pregunta:", len(TOPICS), "| mensajes por familia ~", len(convos)//len(TOPICS))
print("Familias CUBIERTAS por context.md:", covered_count, "/", len(TOPICS))
print("Conversaciones que el bot NO podría fundamentar:", sum(tested[g] for g in gaps))
print()
print("HUECOS detectados (el bot improvisaría / respondería mal):")
for g in gaps:
    print("  ❌", g, "—", tested[g], "preguntas de prueba")
open(os.path.join(os.path.dirname(__file__),"qa_convos.json"),"w",encoding="utf-8").write(json.dumps(convos,ensure_ascii=False,indent=0))

# --- CONTRADICCIONES: lo que el context NO puede decir -------------------------------------------
# El coche de apoyo y las comidas son del suplemento GUIADO (+550), nunca de un paquete. Esto ya se
# corrigió el 24-jul-2026 y volvió a aparecer el 4-ago en 7 sitios (descripción de Deluxe, "ONLY on
# Deluxe", cabecera de EXAMPLES, luggage, safety...): el bot cotizaba Deluxe a 3.750 CON support car,
# que es una venta falsa. Regla mecánica en vez de otra frase de prosa: cualquier línea que nombre el
# coche de apoyo o "all meals" tiene que nombrar en la MISMA línea el guiado o el +550.
NEEDS_GUIDED = re.compile(r"support car|support vehicle|all meals", re.I)
HAS_GUIDED   = re.compile(r"guided|550", re.I)
lines = open(os.path.join(os.path.dirname(__file__),"..","context.md"), encoding="utf-8").read().splitlines()
bad = [(i+1, l.strip()[:120]) for i, l in enumerate(lines) if NEEDS_GUIDED.search(l) and not HAS_GUIDED.search(l)]
print()
print("CONTRADICCIONES (support car / meals prometidos sin el guiado):", len(bad))
for n, l in bad:
    print("  ❌ línea", n, "—", l)
if bad or gaps:
    raise SystemExit(1)
