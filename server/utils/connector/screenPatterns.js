// The one pattern list for the connector's screening check (spec 2026-11-19
// section 7.6, guard 1): wording in client-written text that is addressed to an AI.
//
// Every pattern runs on the view textGuards.js builds: entities and percent
// escapes decoded, lowercase, accents and invisible characters gone,
// lookalike letters mapped to ASCII, curly quotes straight, every run of
// whitespace one space. So the patterns are written in lowercase with single
// spaces. FLAT patterns see the whole text on one line, and once more with
// every destination the shared detector finds replaced by the token xdestx
// (DEST below), and once more with digits read as letters. LINE patterns see
// the line breaks (m flag). WHOLE patterns see the whole text with its line
// breaks and no m flag. COMPACT patterns see only letters and digits, for a
// command spelled with spaces, dots or symbols between its letters, forwards
// and reversed.
//
// The rule of the list: a trigger verb alone never matches. A pattern needs
// the AI-addressed framing (an instruction or prompt as the object, an AI as
// the addressee, other people's data as the cargo, a role or tool message as
// the costume) AND, where the framing is mild, an action. A client sending
// data TO the business ("I'll send you the guest list") is never an attack.
// The withhold tier is held to precision (no ordinary message in the pass
// tables may be withheld); the flag tier may be broader, but a flag still
// writes a log row and emails the owner, so it stays quiet on ordinary
// messages too. When one ordinary wording keeps tripping, narrow its pattern
// here and add the wording to the pass table in textGuards.test.js.
//
// Linear time: every run a pattern can open on is anchored to the start of
// its run (a lookbehind for the same characters) or bounded, so no pattern
// rescans a long run from every position. textGuards.js also refuses text
// over 50,000 characters before any pattern runs.
//
// Each entry is { id, re, tier } (source strings; textGuards.js compiles
// them). tier is 'withhold' for the narrow set no real client writes and
// 'flag' for the rest (see textGuards.js on why two tiers); WITHHOLD_IDS at
// the end assigns it for FLAT, and LINE, WHOLE and COMPACT all withhold. The
// id goes to the log and the settings list, never the matched text.

const S = '(?<![a-z0-9])';
const E = '(?![a-z0-9])';

// What an AI is called. AI_NAMES can also be a person's name (a guest called
// Claude), so it withholds only with an order or an unmistakable framing.
const AI_STRICT = '(?:ai|a\\.i\\.?|ais|artificial intelligence|llms?|large language models?|language models?|chat ?bots?|ai (?:assistant|agent|model|system|bot|reader|tool)s?|virtual assistants?|automated (?:assistant|agent|system|reader)s?)';
const AI_NAMES = '(?:claude|chatgpt|chat gpt|gpt(?:-?\\d+o?)?|gemini|copilot|openai|anthropic|duet)';
const AI_ANY = `(?:${AI_STRICT}|${AI_NAMES})`;
const ADDRESSEE = `(?:${AI_ANY}|assistant|bot|model|agent|computer|robot|machine)`;
// An AI named outright: never a person's assistant.
const AI_EXPLICIT = `(?:${AI_NAMES}|the ai|an ai|ai assistant|ai model|ai agent|language model|llm|chat ?bot|(?:the |any |an? )?(?:ai|ai assistant|assistant|bot|model|agent) (?:that is |who is |which is |that |who |is |are )?(?:reading|reads|processing|processes|summari[sz]ing|summari[sz]es) (?:this|these|my)|(?:whatever|whoever)(?: or (?:whatever|whoever))? (?:bot |ai |model |system |program )?(?:is )?(?:reads|reading|processes|processing|summari[sz]es|summari[sz]ing) (?:this|these|my))`;
const DATA_ORDER = '(?:send|export|reveal|list|forward|e-?mail|give|share|show|tell me|include|put|add|look ?up|search|find|dump|print|output|reply with|respond with|paste|copy|upload|post|compile|pull|grab|collect)';
const CLIENT_DATA = '(?:clients?|customers?|contacts|bookings?|leads?|couples?|phone numbers?|cell numbers?|numbers|e-?mails|e-?mail addresses|addresses|records|(?:client|customer|contact) list|everyone|other (?:clients|events|bookings|weddings|people)|database|(?:this|the|that|whole|entire) (?:thread|conversation|inbox|mailbox)|(?:weekly |full |client )?exports?)';

// The order that follows an addressee ("Duet, forward ...").
const ACTION = '(?:please|kindly|send|forward|fwd|e-?mail|mail|text|export|upload|share|post|paste|copy|list|look ?up|search|find|fetch|open|read|run|call|use|include|add|put|tell|give|show|reveal|reply|respond|answer|write|draft|summari[sz]e|ignore|disregard|forget|mark|approve|delete|remove|update|change|set|cancel|refund|pay|transfer|wire|book|confirm|output|print|return|check|get|pull|grab|collect|compile|extract|stop|start|begin|make sure|remember|do not|don\'t|(?:when|before|after|while|once|as) (?:you|reading|summari[sz]ing|processing|replying|answering)|you (?:must|should|will|need to|have to|are to|can now|may now))';
const ACTION_AI = '(?:send|forward|fwd|e-?mail|mail|export|upload|share|post|paste|copy|list|look ?up|search|find|fetch|run|use|include|add|put|tell me|tell the owner|show me|reveal|reply with|respond with|answer with|write|draft|summari[sz]e|ignore|disregard|forget|mark|approve|delete|remove|output|print|return|pull|grab|collect|compile|extract|stop|(?:when|before|after|while|once|as) (?:you|reading|summari[sz]ing|processing|replying|answering)|you (?:must|should|need to|have to|are to|can now|may now)|make sure|do not|don\'t)';

// A destination, as the shared detector found it, or named in words.
const DEST = '(?:xdestx|xmailx|(?:this|that|the following|my|our|an?) (?:url|link|address|endpoint|webhook|server|site|web ?page|api)|(?:an? |my |our |this )?(?:webhook|endpoint|external (?:address|server|site|url)))';
const DEST_URL = '(?:xdestx|(?:this|that|the following) (?:url|link|address|endpoint|webhook|web ?page))';

// The client speaking of what THEY will send: never an attack.
const NOT_SELF = '(?<!(?:i\'ll|i will|we\'ll|we will|i can|we can|i\'m going to|i am going to|we\'re going to|we are going to|let me|i\'d like to|i would like to|i\'ve|i have|we have|we\'ve|i just|we just|i|we|i\'ll be|we\'ll be|i will be|i\'d|we\'d|i\'ll also|we\'ll also) )';

// Instruction overrides.
const OVERRIDE_VERB = '(?<!(?:don\'t|do not|dont|never|not|n\'t|i|we|did i|did we|did you|have you|you|to|might|may|could|would|they|he|she|who|that|i\'ll|we\'ll|i\'d|we\'d) )(?:ignore|disregard|forget|override|bypass|pay no attention to|never ?mind|do not follow|don\'t follow|dont follow|do not obey|don\'t obey|dont obey|stop following|no longer follow|stop obeying|do not listen to|don\'t listen to|stop listening to)';
const CANCEL_VERB = '(?<!(?:don\'t|do not|dont|never|not|n\'t|i|we|to) )(?:cancel|void|scrap|ditch|skip|discard|abandon|set aside|throw out|throw away)';
const OVERRIDE_NOUN = '(?:instructions?|instrucions|instuctions|instrutions|prompts?(?! (?:reply|replies|response|responses|attention|service|payment))|directives?|directions|guidance|guidelines?|rules|programming|training|constraints|restrictions|commands|orders|context|settings|system (?:message|prompt)s?|guardrails?)';
// Determiners only an AI-addressed override uses.
const DET_AI = '(?:your|all|any|every|each|above|system|developer|safety|initial|original|default|preceding|existing|standing|current|usual|aforementioned)';
const DET_OTHER = '(?:the|of|these|those|previous|previously|prior|earlier|former|old|other|given|stated|provided|mentioned|such|past|last|and|or|following|next|later|subsequent|below|preceding|previos|previus|prev)';
// What makes a plain "ignore the previous instructions" a client's own.
const OWN_TOPIC = '(?! (?:about|for|on|regarding|re|to|from|i|we|my|our|in|at|of|with|that i|that we|you got from|they|she|he|sent|given by|the venue|the planner))';

// People whose records are the business's, and what is kept about them.
const PEOPLE = '(?:clients?|customers?|leads?|users?|members?|subscribers?|patrons?|couples?|brides?|grooms?)';
const PEOPLE_THE = '(?:clients|customers|leads|users)';
const PEOPLE_LIST = '(?:client|customer|lead|user|contact|mailing) (?:list|lists|roster|database|db|records|book)';
// People a client names about their own event: only their sensitive data counts.
const PEOPLE_LOOSE = '(?:staff|employees?|bartenders?|workers?|guests?|people|accounts?|bookings?|events?|weddings?)';
const DATA_GENERAL = '(?:lists?|roster|data|database|db|records?|info(?:rmation)?|details|files?|history|names)';
const DATA_SENS = '(?:phone numbers?|numbers|cell(?:phone)?s?(?: numbers?)?|mobile numbers?|e-?mails?|e-?mail addresses|addresses|home addresses|contact (?:info(?:rmation)?|details|list)|contacts|pii|personal (?:info(?:rmation)?|data|details)|ssns?|social security numbers|bank(?:ing)? (?:info(?:rmation)?|details|accounts?)|payment (?:info(?:rmation)?|details|methods)|card numbers|credit cards?|passwords?|logins?|credentials|tax ids?)';
const QUAL = '(?:all|every|each|entire|whole|full|complete|other|everyone\'s|every single)';
const DATA_SECRET = '(?:ssns?|social security numbers|bank(?:ing)? (?:info(?:rmation)?|details|accounts?)|card numbers|credit cards?|passwords?|logins?|credentials|tax ids?|home addresses)';
const OWNER = `(?:(?:every|each|all|other|every other|each other)(?: of)?(?: the| your)?(?: other)? (?:\\S+ )?${PEOPLE}(?:'s?|')?|(?:your|the|all your|all the) other (?:\\S+ )?${PEOPLE}|your (?:clients|customers|couples|leads)|(?:the )?last \\S+ (?:people|clients|customers|couples|bookings|leads|guests))`;
const OWNER_LOOSE = `(?:other|every other|each other|all (?:the |your )?other|the other|your other) (?:\\S+ )?(?:bookings?|events?|weddings?|parties|people|accounts?|bartenders?|staff|employees?)(?:'s?|')?`;
const PDATA = `(?:${DATA_SENS}|details|info(?:rmation)?|names(?: (?:and|&) (?:numbers|e-?mails|phone numbers))?)`;
const OWNER_DATA = `(?:${OWNER} (?:\\S+ ){0,2}?${PDATA}|${PDATA} (?:of|for|from) (?:\\S+ ){0,2}?${OWNER}|${OWNER_LOOSE} (?:\\S+ ){0,2}?${DATA_SENS}|${DATA_SENS} (?:of|for|from) (?:\\S+ ){0,2}?${OWNER_LOOSE}|${DATA_SENS} (?:of|for|from) (?:everyone|everybody|anyone)(?: else)?|(?:everyone|everybody)(?: else)?'s ${DATA_SENS})`;
const BULK = `(?:${QUAL} (?:(?:of )?(?:the|your|its) )?(?:\\S+ )?${PEOPLE}(?:'s?|')? (?:${DATA_GENERAL}|${DATA_SENS})|${QUAL} (?:(?:of )?(?:the|your|its) )?(?:\\S+ )?${PEOPLE_LOOSE}(?:'s?|')? ${DATA_SECRET}|(?:your|the|this|that) ${PEOPLE_THE}(?:'|s')? (?:${DATA_GENERAL}|${DATA_SENS})|(?:your|the|their|this) (?:full |complete |entire |whole )?${PEOPLE_LIST}(?! of (?:\\S+ )?(?:vendors|venues|rentals?|rental|suppliers|bartenders|caterers|djs?|florists|photographers|drinks|cocktails|bebidas))|(?:a |the |full |complete |entire |whole )?list (?:of )?(?:all )?(?:(?:your|the|their) )?(?:other )?(?:past |current |previous )?(?:clients|customers|couples|leads)|(?:all )?(?:your|all your|all the|all of your) contacts|${OWNER_DATA}|(?:every|each|all(?: of)?(?: the)?) (?:messages?|e-?mails?|texts?|threads?|conversations?) (?:in|from) (?:this|the|your) (?:inbox|mailbox|account|system|os)|(?:entire|whole|full) (?:inbox|mailbox))${E}`;
const EXFIL_SEND = '(?:send|resend|forward|fwd|export|upload|e-?mail|mail|text|sms|share|post|paste|leak|dump|exfiltrate|transmit|transfer|copy|sync|push|submit|write|output|print|list|reveal|display|show|give|provide|fetch|download|retrieve|extract|scrape|compile|collect|gather|summari[sz]e|attach|relay)';
const EXFIL_VERB = '(?:send|resend|forward|fwd|export|upload|e-?mail|mail|text|sms|share|post|paste|leak|dump|exfiltrate|transmit|transfer|copy|sync|push|submit|write|output|print|list|reveal|display|show|give|provide|fetch|download|retrieve|extract|scrape|compile|collect|gather|summari[sz]e|attach|relay|include|put|add|insert|append|look ?up|tell me|read (?:me|out)|draft)';
const SECRETS = `(?:your|the|all|any) (?:system prompt|setup (?:message|prompt|instructions)|initial message|api[ _-]?keys?|secret[ _-]?keys?|access[ _-]?tokens?|auth(?:entication)?[ _-]?tokens?|bearer tokens?|oauth tokens?|refresh tokens?|credentials|passwords|(?:full |entire |whole )?(?:conversation|chat) history|context window|database|db|crm|env(?:ironment)? (?:variables|vars|file)|\\.env|connection strings?|tool list|connectors)${E}`;
const OBJ_AI = '(?:(?:the|this|these|your|all|any|my) )?(?:(?:entire|whole|full|complete) )?(?:conversation|chat|context|data|contents?|everything (?:above|you (?:know|have|see|found|read))|above|information (?:above|you (?:have|found|see))|info (?:above|you (?:have|found))|what you (?:know|have|found|see|read)|history|memory|transcript|records|findings|tool results?|search results|(?:all|other) (?:clients?|customers?)|their (?:details|info|data|e-?mails|numbers))';
const PROCESS_AI = '(?:summari[sz]e|summari[sz]ing|parse|parsing|analy[sz]e|analy[sz]ing|ingest|ingesting)';
const PROCESS_ANY = `(?:${PROCESS_AI}|read|reading|review|reviewing|process|processing|scan|scanning|reply|replying|respond|responding|answer|answering|draft|drafting)`;
const HARVEST = '(?:look ?up|search|find|collect|gather|extract|harvest|compile|grab|pull|scrape)';
const PUT = '(?:include|put|add|append|attach|insert|list|copy|paste|post|send|forward|email|e-mail|mail)';

const FLAT = [
  // 1. Orders about instructions, roles and system prompts.
  {
    id: 'override-instructions',
    re: `${S}${OVERRIDE_VERB} (?:(?:${DET_OTHER}|${DET_AI}) ){0,5}?${DET_AI} (?:(?:${DET_OTHER}|${DET_AI}) ){0,4}${OVERRIDE_NOUN}${E}|${S}${CANCEL_VERB} (?:(?:${DET_OTHER}|${DET_AI}) ){0,5}?${DET_AI} (?:(?:${DET_OTHER}|${DET_AI}) ){0,4}(?:instructions?|prompts?|directives?|programming|guardrails?|guidance|rules)${E}`,
  },
  {
    id: 'override-plain',
    re: `${S}${OVERRIDE_VERB} (?:${DET_OTHER} ){0,4}${OVERRIDE_NOUN}${E}${OWN_TOPIC}`,
  },
  {
    id: 'override-above',
    re: `${S}${OVERRIDE_VERB} (?:all |everything |all of )?(?:the |everything )?(?:above|text above|message above|preceding text)(?:$| ?[.!,;:]| and| text| message| instructions?| content| prompt| lines?)`,
  },
  {
    id: 'override-everything',
    re: `${S}(?:ignore|disregard|forget|pay no attention to) (?:everything|anything|all(?: of)?(?: that| this| the)?) (?:above|before this|prior to this|(?:that )?you(?:'ve| have| were| had)? (?:been )?(?:told|given|instructed|taught|programmed|trained|asked|learned|learnt|read|seen)(?: so far| before| until now| in this thread)?|(?:written )?(?:before|above) (?:this|here)(?: line| message| point)?)${E}|${S}forget everything(?: ?[.!]|$| and (?:now|instead|from now))|${S}(?:ignore|disregard) (?:everything|all) (?:above|before)${E}`,
  },
  {
    id: 'what-you-were-told',
    re: `${S}(?:ignore|disregard|forget|override|pay no attention to|never ?mind) (?:\\S+ ){0,2}?what (?:you(?:'ve| have| were| was| had)? (?:been )?(?:told|given|instructed|taught|asked|programmed)|you know|your instructions say|they told you|the (?:system|developer|owner) (?:said|told you))${E}|${S}what (?:were you|have you been) told (?:before|at the start|earlier|initially)${E}|${S}before this (?:conversation|chat|session) (?:started|began)${E}`,
  },
  {
    id: 'instructions-void',
    re: `${S}your (?:(?:previous|prior|original|initial|old|earlier|current|system) )?(?:instructions?|programming|prompts?|guidelines|rules|directives|guidance|task|orders) (?:no longer apply|(?:are|is) (?:now )?(?:void|cancell?ed|revoked|obsolete|out of date|outdated|null|invalid|suspended|lifted|superseded|overridden)|have (?:been )?(?:changed|updated|revoked|replaced|lifted|cancell?ed|superseded)|has (?:been )?changed|(?:do|does) not apply|don't apply|(?:are|is) no longer (?:valid|in effect|active|relevant))${E}|${S}(?:all |the )?(?:previous|prior) (?:instructions|directives|prompts) (?:no longer apply|(?:are|is) (?:now )?(?:void|cancell?ed|revoked|null|invalid|superseded|overridden))${E}|${S}(?:instructions?|directions|guidance|rules|prompts?) you (?:were given|have been given|received|got)(?: \\S+){0,3}? (?:are|is) (?:now )?(?:void|out of date|outdated|obsolete|cancell?ed|revoked|invalid|superseded|replaced)${E}`,
  },
  {
    id: 'new-task',
    re: `${S}(?:new|next|real|actual|secret|hidden|priority|override) (?:task|instructions?|directives?|objective|mission|assignment|orders) ?:(?! ?(?:(?:can|could|would|will|do|are|is) (?:you|we|i)${E}|please (?:quote|let me)|what|how|when|where|i |we |my |our ))|${S}your (?:next|new|real|actual|only|true|primary|first|current|sole) (?:task|instructions?|directives?|objective|mission|assignment) (?:is|are|will be|now is|:)|${S}your (?:task|instructions?|orders|directives?|mission) (?:has|have) changed${E}|${S}you have (?:new|updated|different|fresh) (?:orders|instructions|directives|tasks?|commands|assignment)${E}|${S}(?:comply with|obey) (?:the following|these|my|the new|all of the following) (?:directions|instructions|commands|orders|rules|directives)${E}`,
  },
  {
    id: 'summary-order',
    tier: 'flag',
    re: `${S}do (?:exactly )?what this (?:message|text|email|note) says${E}|${S}do the following instead${E}|${S}stop what you(?:'re| are) doing${E}|${S}(?:instead of|rather than) (?:summari[sz]ing|a summary|summary|writing (?:a|the|your) summary)${E}|${S}(?:do not|don't|dont|never) summari[sz]e (?:this|it|the|my)${E}|${S}summari[sz]e (?:this|the|my)(?: message| email| thread| text| conversation)? as ?:|${S}(?:start|begin|end|open|close) your (?:summary|reply|answer|response|briefing) (?:with|by)${E}|${S}(?:when|while|before|as|after|once) (?:you )?(?:answer|answering|reply|replying|respond|responding|report|reporting|brief|briefing|write|writing) (?:to )?(?:the owner|the boss|the business|the user)${E}|${S}(?:do not|don't|dont|never) (?:show|forward|mention|surface|display|flag) (?:this|it|the message|the thread|the email) to (?:the )?(?:owner|admin|user|boss)${E}|${S}mark (?:this|the) (?:thread|message|email|conversation) as (?:handled|read|done|resolved|spam|closed)${E}|${S}in your (?:summary|digest|briefing),? (?:say|state|mention|write|note|include|add|tell|report)${E}`,
  },
  {
    id: 'injection-heads',
    re: `${S}update to your (?:instructions|rules|prompt|programming|guidelines)${E}|${S}important:? new instructions${E}|${S}(?:ai|assistant|bot|claude|duet|chatgpt|model) instructions ?:|${S}end of (?:the )?(?:prompt|system prompt|instructions)${E}|${S}(?:now you are|you are now) dan${E}(?! (?:on|from|and|at|in|with|for|'s))|${S}(?:repeat|output|print|recite) (?:the )?(?:words|text|initiali[sz]ation) above (?:starting|beginning|from)${E}|${S}output (?:the )?initiali[sz]ation${E}|${S}act as (?:a |an )?(?:linux |unix |bash |python |windows )?(?:terminal|shell|console|interpreter)${E}|${S}you(?:'re| are) an? (?:ai |)assistant (?:with no|without) (?:restrictions|rules|limits|filters)${E}|${S}from now on,? (?:respond|reply|answer|act|behave)(?: \\S+){0,4}? (?:with|as|only)${E}|${S}from now on,? you will (?:answer|respond|reply)(?: \\S+){0,4}? with${E}`,
  },
  {
    id: 'system-prompt',
    re: `${S}(?<!(?:payment|booking|checkout|website|web|site|portal|card|pos|phone|computer|app|stripe|square|venmo|zelle|bank|online|ticket|reservation|sound|alarm) )(?:system|developer|hidden|secret|initial|original|internal|meta)[ _-]*prompts?(?! (?:me|us|you|him|her|them|for|to|that|says|said|asked|asks|told|tells|showed|shows|popped|came|appeared|keeps|said))${E}|${S}(?:system|developer)[ _-]*(?:message|instructions?|directives?|override|role)s? ?:|${S}(?:new|updated|following|hidden|secret|real|fake) (?:system|developer)[ _-]*(?:message|instructions?|directives?)s?${E}|${S}developer (?:instructions?|directives?|override)${E}|${S}your setup (?:message|prompt|instructions)${E}`,
  },
  {
    id: 'claimed-instructions',
    re: `${S}(?:real|actual|true|hidden|secret|override|admin|administrator|developer|priority|master|root|confidential|system|updated system|new system) (?:instructions?|directives?|prompts?|orders|commands) ?(?::|-|follow|(?:are|is) (?:to |that |as follows|below|:))`,
  },
  {
    id: 'your-hidden-instructions',
    re: `${S}your (?:(?:new|real|actual|true|original|initial|hidden|secret|core|base|underlying|internal|system|developer) ){1,3}(?:instructions?|prompts?|directives?|programming|guidelines|rules|task|goal|purpose|objective|mission)${E}|${S}(?:override|ignore|change|break|forget|against|beyond|outside|bypass) (?:of )?your programming${E}`,
  },
  {
    id: 'reveal-prompt',
    re: `${S}(?:reveal|show|print|repeat|output|display|dump|leak|tell me|give me|share|quote|what is|what's|what are|what were) (?:me )?(?:your (?:(?:full|entire|exact|complete|original|initial|hidden|secret|system|internal|underlying) )*|the (?:(?:full|entire|exact|complete) )*(?:(?:original|initial|hidden|secret|system|internal|underlying) )+)(?:prompt|programming|initial instructions|original instructions|hidden instructions|system instructions|internal instructions|setup message|setup prompt)${E}(?! (?:reply|replies|response|responses|attention|service|payment|help|turnaround|delivery|action|follow))|${S}(?:output|print|reveal|quote) the full text of your${E}`,
  },
  {
    id: 'repeat-above',
    re: `${S}(?:repeat|print|output|reveal|display|dump|echo|recite|write out|spell out|copy) (?:back )?(?:me )?(?:all (?:of )?)?(?:the )?(?:text|words|everything|content|contents|prompt|messages?) (?:above|before this|prior to this|preceding|that came before|you were given|you received|in your context) (?:verbatim|exactly|word for word|in full)${E}|${S}(?:repeat|print|output|reveal|display|dump|echo|recite) (?:back )?(?:me )?(?:everything|all (?:of )?the text) (?:above|before this|you were given|you received|in your context)${E}|${S}(?:repeat|print|output|recite) (?:back )?your (?:instructions|prompt|rules|guidelines)${E}`,
  },
  {
    id: 'role-you-are-now',
    re: `${S}you(?: are|'re| r| will be|'ll be) (?:now|no longer|henceforth) (?:\\S+ ){0,5}?(?:an? )?(?:${AI_ANY}|jailbroken|unrestricted|unfiltered|uncensored|unbound|unaligned|unchained|unshackled|evil|rogue|(?:developer|dev|god|admin|sudo|debug|jailbreak|unrestricted|dan) mode)${E}|${S}you(?: are|'re) now (?:a |the )?dan${E}(?! (?:on|from|and|at|in|with|for|'s))|${S}you(?: are|'re) no longer (?:\\S+ ){0,2}?(?:bound|restricted|constrained|limited) by (?:any |your |the )?(?:rules|guidelines|instructions|policies|filters|safety|restrictions|guardrails|${AI_NAMES})${E}|${S}you (?:now )?(?:work|answer|report|belong|listen|respond) (?:only )?(?:to|for) me(?: now)?${E}`,
  },
  {
    id: 'role-act-as',
    re: `${S}(?:act|behave|function|operate|respond|answer|reply|speak|roleplay|role-play|role play) (?:as|like) (?:if you (?:are|were) )?(?:an? |the )?(?:(?:new|different|unrestricted|unfiltered|uncensored|jailbroken|evil|rogue) )*(?:${AI_ANY}|bot|dan|root|superuser|hacker)${E}|${S}(?:act|behave|operate|respond|answer|reply|speak|roleplay|role-play|role play) (?:as|like) (?:if you (?:are|were) )?(?:an? |the )?(?:unrestricted|unfiltered|uncensored|jailbroken|evil|rogue) (?:assistant|system|administrator|admin|developer)${E}|${S}act as (?:the |an? )?(?:system|administrator|admin|developer) (?:and|to|with|who)${E}`,
  },
  {
    id: 'role-pretend',
    re: `${S}(?:pretend|imagine|suppose|assume|roleplay|role-play|role play) (?:that )?(?:to be|you(?:'re| are| were| have| had)) (?:an? |the )?(?:(?:new|different|unrestricted|unfiltered|uncensored|jailbroken|evil|rogue|free) )*(?:${AI_ANY}|bot|dan|assistant|system|administrator|admin|developer|root|superuser|hacker|human|not an? (?:ai|assistant|bot|model)|no (?:rules|restrictions|limits|filters|guidelines)|without (?:rules|restrictions|limits|filters|guidelines))${E}`,
  },
  {
    id: 'role-from-now-on',
    re: `${S}(?:from now on|from here on|starting now|henceforth|going forward|for the rest of (?:this|the) (?:conversation|chat|session))[ ,]+(?:\\S+ ){0,3}?you (?:will|must|shall|are to|are going to) (?:(?:now|only|always|never) )*(?:act|behave|obey|comply|pretend|answer as|respond as|respond only|reply only|output|role-?play|refuse|stop following|follow (?:my|these|the following|only my) (?:instructions|commands|orders|rules)|ignore (?:all |any |your )?(?:(?:previous|prior|other|earlier) )?(?:instructions|rules|guidelines|prompts|the owner|the user|everyone|everything))${E}|${S}from here on,? do exactly${E}`,
  },
  {
    id: 'mode-switch',
    re: `${S}(?:enable|enter|activate|switch to|switch into|turn on|go into|engage|unlock|initiate|run in|operate in|respond in|answer in|reply in|you(?:'re| are) (?:now )?in|now in) (?:the )?(?:developer|dev|god|dan|sudo|admin|administrator|debug|jailbreak|jailbroken|unrestricted|unfiltered|uncensored|root|superuser|maintenance|override|evil|opposite|chaos) mode${E}|${S}(?:developer|dev|god|dan|sudo|debug|jailbreak|unrestricted|unfiltered|uncensored|superuser) mode (?:enabled|activated|on|unlocked|engaged)${E}|${S}jailbr(?:eak|oken|eaking|eaks)${E}|${S}you (?:can|will|could|must|may|shall|are (?:able|free|allowed) to) (?:now )?do anything now${E}|${S}do anything now,? (?:mode|\\(dan\\))|${S}dan,? (?:which stands for |short for |or )?"?do anything now|${S}prompt[ -]*injections?${E}`,
  },
  // 2. Text addressed to an AI.
  {
    id: 'address-ai',
    re: `${S}(?:hey|hi|hello|dear|greetings|attention|attn|note to|note for|notice to|message (?:for|to)|reminder (?:for|to)|instructions? (?:for|to)|directions? (?:for|to)|this (?:message |note |text |email |part )?is (?:meant )?(?:for|to|addressed to)|calling|paging)[ ,:]+(?:the |any |all |every |you,? )?${AI_STRICT}${E}|${S}(?:note to|note for|notice to|message (?:for|to)|reminder (?:for|to)|instructions? (?:for|to)|attention|attn|dear|this (?:message |note |part )?is (?:meant )?(?:for|to))[ ,:]+(?:the |any |our |you,? )?(?:${AI_NAMES}|assistant|bot|chatbot|model|agent)${E}(?! (?:manager|coach|director|principal|coordinator|planner|team|staff))|${S}(?:to|for) (?:any|all|every) ${AI_STRICT}(?=$|[,.:;!?]| (?:reading|that|who|which|out there|systems?|models?|agents?|assistants?))|${S}(?:meant|intended|written|addressed|directed) (?:for|to|at) (?:the|any|an?|you,? the) ${AI_ANY}${E}`,
  },
  {
    id: 'addressee-order',
    re: `(?:^|[.!?;:"] )(?:(?:hey|hi|hello|ok|okay|yo|dear|attention|attn|admin note:?|note:?) )?(?:the )?${ADDRESSEE},? ?[,:;!-]* ?(?:(?:please|kindly|now|also|just|quickly|first|then) )*(?:(?:can|could|would|will) you (?:please )?|i need you to |i want you to |you need to )?${ACTION_AI}${E}|${S}(?<!(?:my|our|her|his|their|your) )(?:the )?(?:${AI_ANY}|assistant|bot) (?:should|must|needs? to|has to|is to|is required to|shall|can now|is (?:now )?(?:authori[sz]ed|allowed|permitted|instructed) to) (?:\\S+ ){0,2}?${ACTION_AI}${E}`,
  },
  {
    id: 'reader-of-this',
    re: `${S}(?:to |for )?(?:the |any |an? )?${ADDRESSEE} (?:that|who|which) (?:reads?|is reading|will read|processes|is processing|summari[sz]es|is summari[sz]ing|parses|ingests) (?:this|these|the following|my|our)${E}|${S}(?<!(?:my|our|her|his|their|your|the venue's|the planner's) )(?:${AI_ANY}|assistant|agent|bot|model)s? (?:that is |who is |which is |is |are )?(?:reading|processing|summari[sz]ing|parsing|analy[sz]ing|scanning|ingesting) (?:this|these|the following|my|our)${E}|${S}(?:virtual |ai |automated )?assistant (?:handling|managing|monitoring|reading) (?:this|the) (?:inbox|thread|mailbox|conversation)${E}|${S}(?:machine|automated|ai) readers?${E}|${S}whoever \\(?or whatever\\)?${E}|${S}whatever (?:\\S+ )?(?:is )?(?:reads?|reading|processes|processing|summari[sz]es|summari[sz]ing|parses|parsing|scans|scanning) (?:this|these|the following|my)${E}|${S}whoever or whatever${E}|${S}whoever (?:is )?(?:processing|processes|summari[sz]ing|summari[sz]es|parsing|parses|scanning|scans|ingesting) (?:this|these|the following|my)${E}`,
  },
  {
    id: 'if-you-are-ai',
    tier: 'flag',
    re: `${S}if you(?:'re| are| r) (?:an? )?(?:${AI_ANY}|bot|automated|assistant|model|agent|machine|not (?:a )?human)${E}|${S}if (?:an? |any |the )?${ADDRESSEE} (?:\\S+ ){0,2}?(?:is |are )?(?:reading|processing|summari[sz]ing|parsing|reviewing|handling|seeing|sees|reads|gets)${E}`,
  },
  {
    id: 'ai-data-order',
    tier: 'withhold',
    re: `${S}${AI_EXPLICIT}${E}[,:;!.-]{0,3}(?: \\S+){0,20}? ${DATA_ORDER}${E}(?: \\S+){0,10}? (?:\\S+ )?${CLIENT_DATA}${E}`,
  },
  {
    id: 'you-are-an-ai',
    re: `${S}you(?:'re| are) (?:an?|the) (?:${AI_STRICT}|${AI_NAMES}) (?:that|who|which|named|called|designed|programmed|built|created|trained|tasked|whose|with no|without|and you|working for)${E}|${S}you(?:'re| are) (?:an?|the) (?:(?:helpful|harmless|honest|obedient|unrestricted|friendly)(?:,? and)? )+(?:ai )?assistant${E}|${S}as an? (?:${AI_STRICT}|${AI_NAMES}),? (?:\\S+ ){0,4}?you (?:must|will|should|shall|need to|have to|are required to)${E}`,
  },
  {
    id: 'the-user-wants',
    re: `${S}the (?:user|human|operator) (?:has |have )?(?:authori[sz]ed|approved|permitted|allowed|instructed|granted|wants you|asked you|asks you|requests that you|needs you|would like you|expects you|told you|has asked you|is asking you)${E}`,
  },
  {
    id: 'hide-from-owner',
    re: `${S}(?:do not|don't|dont|never|without) (?:tell(?:ing)?|inform(?:ing)?|notify(?:ing)?|alert(?:ing)?|show(?:ing)?|mention(?:ing)?(?: (?:it|this))? to) (?:the )?(?:user|human|operator|admin|administrator|owner)(?: about)? (?:this|that|it|my) (?:message|email|text|request|instruction|thread)s?${E}|${S}(?:do not|don't|dont|never) (?:let|tell) (?:the )?(?:owner|user|admin|operator) know (?:about )?(?:this|that|my) (?:message|email|text|request|instruction)s?${E}`,
  },
  {
    id: 'override-owner',
    re: `${S}(?:ignore|disregard|override|bypass|overrule) (?:the |your )?(?:owner|user|operator|admin|administrator|human)(?:'s)?${E}(?! of)`,
  },
  {
    id: 'claims-authority',
    re: `${S}as (?:the|your) (?:owner|admin|administrator|developer|operator|boss|creator)(?: of (?:this|the|your) (?:business|company|account|system|bot|assistant))?,? (?:i|we) (?:am |'m |are |'re )?(?:telling|ordering|instructing|authori[sz]ing|asking|requiring|directing|commanding|permitting) you${E}|${S}i (?:hereby )?(?:authori[sz]e|permit|allow|instruct|order|command) you to (?:\\S+ ){0,3}?(?:send|forward|export|share|email|e-?mail|upload|post|reveal|list|give|disclose)${E}|${S}(?:admin|administrator|system|developer|owner|operator)(?:'s)? (?:note|message|notice|instruction|directive|override|update|memo)s? ?:|${S}tell (?:the )?(?:owner|admin|user|boss) (?:that )?(?:this|he|she|they|it|the client)${E}(?: \\S+){0,12}? (?:must|has to|is required to) (?:wire|refund|transfer|release|return|mark)${E}`,
  },
  // 3. Requests to send, forward, export, upload, email or fetch, and to read
  //    other people's data into the reader's output.
  {
    id: 'exfil-bulk-data',
    re: `${S}${NOT_SELF}${EXFIL_VERB} (?:\\S+ ){0,8}?${BULK}`,
  },
  {
    id: 'bulk-data',
    re: `${S}(?:all|every|entire) (?:(?:of )?(?:the|your|our) )?(?:other )?${PEOPLE}(?:'s?|')? ${DATA_SENS}${E}`,
  },
  {
    id: 'data-into-output',
    re: `${S}(?:put|add|include|write|insert|append|say|mention|state|note|list) (?:\\S+ ){0,8}?(?:in|into|to) your (?:summary|output|summari[sz]ation|digest|briefing|analysis)${E}|${S}${PUT}(?: \\S+){0,8}? (?:${OWNER_DATA}|(?:all|every|each|any)(?: of)?(?: the)? (?:\\S+ )?${DATA_SENS})(?: \\S+){0,6}? (?:in|into|to) (?:your|the) (?:reply|replies|answer|response|next (?:reply|message|answer|response)|message back)${E}|${S}(?:reply|respond|answer) (?:to this (?:email|message|text) |there |here |back )?with (?:\\S+ ){0,4}?(?:${OWNER_DATA}|${PDATA} (?:of|for|from) (?:\\S+ ){0,4}?(?:people|clients|customers|couples|guests|bookings|leads|everyone|everybody|other)|(?:all|every|each|any)(?: of)?(?: the)? (?:\\S+ )?${DATA_SENS}|(?:a )?list of (?:\\S+ )?(?:clients|customers|couples|bookings|leads))${E}|${S}other (?:clients|customers|couples|bookings|events|weddings|people|parties)${E}(?: \\S+){0,15}? (?:(?:their|the) )?(?:names (?:and|&) )?(?:phone numbers|numbers|e-?mails|e-?mail addresses|contact (?:info(?:rmation)?|details)|addresses)${E}`,
  },
  {
    id: 'others-data',
    re: `${S}${DATA_SENS} (?:of|for|from) (?:\\S+ ){0,2}?(?:your|all|all the|every|other|all your|each|the other) (?:\\S+ )?(?:other )?(?:clients|customers|couples|leads|bookings)${E}|${S}(?:every|each|all|other) (?:\\S+ )?(?:clients?|customers?|couples?|leads?)(?:'s?|')? (?:\\S+ )?${DATA_SENS}${E}|${S}who (?:are|else|is) (?:\\S+ ){0,3}?(?:your )?other (?:clients|customers|couples|bookings)${E}`,
  },
  {
    id: 'others-records',
    tier: 'flag',
    re: `${S}(?:client|customer|lead)s?'? (?:phone numbers|cell numbers|e-?mails|e-?mail addresses|addresses|contact (?:info(?:rmation)?|details|list)|numbers|records|data|names|details)${E}|${S}(?:send|give|list|show|tell) me (?:all )?(?:of )?your (?:clients|customers|couples)${E}|${S}who (?:your (?:clients|customers) are|else you have as (?:clients|customers)|else (?:is|has) (?:booked|booking|scheduled))${E}|${S}who booked (?:them|it|those|these)${E}|${S}everyone who (?:owes|booked|has booked|has an unpaid|is booked|has a balance)${E}|${S}(?:the )?(?:money owed|amounts? owed|outstanding|unpaid) (?:list|balances|report)${E}|${S}who owes (?:the most|money|a balance)${E}|${S}(?:the )?list of (?:all )?(?:your )?(?:upcoming|other|all) (?:events|bookings|weddings|parties)${E}|${S}(?:everything|anything|all)(?: you have| you know)? (?:about|on) (?:the |your )?other (?:clients|customers|bookings|couples)${E}|${S}(?:messages?|threads?|emails?|texts?|proposals?|invoices?) (?:from|of|with) (?:your|the) other (?:clients|customers)${E}|${S}(?:thread|messages|emails|conversation) with your (?:most recent |last |other |previous )?(?:clients?|customers?)${E}|${S}(?:the )?(?:people|clients|couples|everyone|folks) (?:with|who have|that have) (?:events?|bookings?|weddings?|parties)(?: \\S+){0,6}? (?:and )?their (?:phone|numbers|e-?mails|contact|addresses)${E}|${S}(?:look|go|search|dig) through (?:the|your|this) (?:inbox|mailbox|messages|threads|emails|records|system|database)${E}|${S}(?:phone numbers?|address(?:es)?|e-?mails?|home address(?:es)?|contact (?:info|details))(?: \\S+){0,15}? (?:of|for) ${OWNER_LOOSE}${E}`,
  },
  {
    id: 'owner-view',
    tier: 'flag',
    re: `${S}(?:in|into) your (?:response|reply|answer|summary|notes|output)(?: to the owner)?,? (?:list|say|state|mention|write|tell|report)${E}|${S}(?:tell|let) (?:the |your )?(?:owner|boss|business owner|manager)(?: know)? (?:that )?(?:\\S+ ){0,10}?(?:approved|discount|refund|waived|comped|mark it|marked|balance should be|nothing owed)${E}|${S}(?:do not|don't|dont|never) (?:show|mention|forward|surface|reveal) (?:this|the) (?:message|email|thread|text) to${E}|${S}hide this (?:message|email|thread|text) from${E}|${S}(?:do not|don't|dont) tell your (?:boss|owner|manager)${E}|${S}(?:report|mark|treat|file|classify|log) (?:this|the) (?:message|thread|email|conversation) as${E}|${S}(?:the )?(?:correct|real|accurate|proper|right) summary (?:of this|is)${E}|${S}every (?:reply|response|answer|summary) (?:must|should|will) (?:include|start|end|contain|say)${E}|${S}(?:additional|updated|revised|extra|important) (?:instructions?|rules?|directives?) ?: ?(?:add|include|list|reply|send|forward|say|tell|mark|ignore|report)${E}|${S}forget what you were doing${E}|${S}${OVERRIDE_VERB} (?:all )?(?:the )?(?:prior|previous|earlier|above) (?:messages|emails|texts)(?: in this (?:thread|conversation))?(?: ?[.!]|$| and )`,
  },
  {
    id: 'setup-probe',
    tier: 'flag',
    re: `${S}(?:what|which) (?:are|were) (?:all )?your (?:instructions|rules|tools|connectors|guidelines)(?: ?[?.!]|$)|${S}what (?:instructions|rules|tools|connectors) (?:were you given|do you have|have you been given)${E}|${S}what tools do you have access to${E}|${S}(?:list|show me|tell me|print|share) (?:all )?your (?:instructions|rules|tools|connectors|guidelines|configuration|config|settings)(?: ?[?.!]|$)|${S}(?:summari[sz]e|tl;?dr(?: of)?|first (?:sentence|line|word)s? of|including|translate) (?:\\S+ ){0,3}?your (?:instructions|prompt|rules|guidelines|configuration)${E}|${S}print (?:the|this) conversation(?: so far)?${E}|${S}(?:written|said) at the (?:top|start|beginning) of this (?:conversation|chat)${E}|${S}translate the above${E}|${S}i am (?:your|the) (?:developer|creator|admin|administrator|programmer|operator)${E}(?! of)|${S}authori[sz]ation code${E}|${S}write (?:the )?(?:client|customer) (?:\\S+ ){0,2}?to a file${E}|^(?:to |for |hey |hi |hello |ok )?(?:the )?(?:duet|chatgpt|copilot|assistant|bot|ai)(?: instructions?)? ?[:,]?$|^(?:to |for |ok )?claude ?:$`,
  },
  {
    id: 'look-up-others',
    re: `${S}look ?up (?:\\S+ ){0,3}?(?:all|every|each|other|the other|the last \\S+) (?:\\S+ )?(?:clients?|customers?|leads?|couples?|people)${E}|${S}look ?up (?:\\S+ ){0,3}?(?:other|the other|the last \\S+) (?:\\S+ )?(?:events?|bookings?|proposals?|weddings?|invoices?)${E}|${S}look ?up (?:client|customer|lead)s? (?:#|no\\.? |number |id )?\\d+|${S}ids? \\d+ (?:through|to|-|until) \\d+${E}|${S}(?:run|do|perform) (?:the |a )?(?:\\S+ )?(?:lookup|look-up|search|query|export|scan) (?:for|on|of|across) (?:every|all|each)${E}|${S}list (?:all|every) (?:(?:of )?(?:the|your) )?(?:other )?(?:clients?|customers?|leads?|users?)${E}|${S}search (?:\\S+ ){0,3}?(?:the system|your system|the inbox|your inbox|the database|your records|the crm|the os|your os) for${E}`,
  },
  {
    id: 'exfil-everything-known',
    re: `${S}${EXFIL_SEND} (?:me |us )?(?:\\S+ ){0,3}?(?:everything|all|anything|whatever) (?:you (?:can find|can access|have access to|can look up)|(?:that )?is in (?:your|the) (?:context|memory|database|inbox|records|system))${E}`,
  },
  {
    id: 'exfil-secrets',
    re: `${S}${EXFIL_SEND} (?:\\S+ ){0,6}?${SECRETS}`,
  },
  {
    id: 'send-output-to-destination',
    re: `${S}(?:send|forward|fwd|e-?mail|mail|post|upload|transmit|submit|exfiltrate|leak|copy|paste|share|sync|push|write|append|attach|report|relay|pipe|dump) (?:\\S+ ){0,3}?${OBJ_AI}${E} (?:\\S+ ){0,6}?(?:to|into|at|via) (?:\\S+ )?${DEST}|${S}(?:send|forward|fwd|e-?mail|mail|copy|share|upload|post) (?:a copy of )?(?:this|the|our|my|your) (?:entire |whole |full )?(?:conversation|chat|transcript|chat history|conversation history|inbox|mailbox)${E}(?: \\S+){0,4}? to (?:my|an|another|other|this|the following|a|their) (?:other )?(?:e-?mail|address|account|inbox|number|server|phone)${E}|${S}use (?:(?:your|the) (?:gmail|email|outlook|slack|drive|calendar|browser|web|search|fetch)|gmail|outlook|slack|google drive)(?: tool| connector| integration| account| access)? to (?:send|forward|e-?mail|share|upload|post|fetch|look ?up|search|read|copy|export)${E}`,
  },
  {
    id: 'fetch-url',
    re: `${S}(?:fetch|curl|wget|crawl|scrape|browse to|navigate to|make an? (?:\\S+ )?request to|send an? (?:get|post|http|https|web|api) request(?: to)?|do an? (?:get|post) (?:request )?(?:to|on)|call (?:the |this )?(?:url|api|endpoint|webhook)|ping(?! (?:me|us|her|him|them|you))|hit (?:the |this )?(?:url|endpoint|api|webhook)|load (?:the |this )?(?:url|page at)|retrieve (?:the )?(?:contents of|url|page at)|read (?:the )?contents of|open (?:the |this )?(?:url|endpoint|webhook))${E} (?:\\S+ ){0,4}?${DEST_URL}`,
  },
  {
    id: 'follow-linked-text',
    re: `${S}(?:follow|obey|execute|carry out|comply with|do) (?:what|whatever|everything|anything|all) (?:it|that|this|the (?:page|link|site|website|web ?page|document|doc|file|url|text|attachment|pdf|note)) (?:says|tells you|asks|instructs|requests|wants|contains|lists)${E}|${S}(?:read|open|visit|fetch|load|check|go to|see) (?:\\S+ ){0,3}?${DEST_URL}\\S* (?:\\S+ ){0,3}?(?:and|then) (?:follow|obey|execute|carry out|comply with|do) (?:it|them|what it says|whatever it says|everything it says|its instructions|those instructions|the instructions(?! (?:to|for|on|about|there|in order)))${E}|${S}(?:follow|obey|execute|carry out|do)(?: what| whatever| all)? (?:the )?(?:instructions?|commands?|orders) (?:at|on|in|from) (?:(?:this|the following) (?:url|link|page|address|endpoint)|xdestx)|${S}(?:decode|decrypt|reverse|unscramble|translate|read (?:this|it) backwards)(?: \\S+){0,5}? (?:and|then) (?:follow|do|execute|obey|run|act on|carry out) (?:it|this|that|them|what it says)${E}`,
  },
  {
    id: 'processing-order',
    re: `${S}(?:when|while|after|before|as|once|if|whenever) (?:you(?:'re| are)? )?(?:\\S+ ){0,2}?${PROCESS_AI}\\w*,? (?:\\S+ ){0,6}?(?:(?:also|first|please|quietly|secretly) )*(?:include|collect|gather|add|append|insert|list|extract|find|grab|pull|compile|copy|paste|harvest|post|send|forward|email|look ?up|search|say|state|mention|tell|write|mark|note|ignore|output|reply)${E}|${S}(?:before|while|when|as) (?:you )?(?:reply|replying|answer|answering|respond|responding|write (?:your|the) (?:reply|summary|answer)|writing (?:your|the) (?:reply|summary|answer)|prepare (?:your|the) (?:reply|summary)|preparing (?:your|the) (?:reply|summary))(?: \\S+){0,3}?,? (?:\\S+ ){0,3}?(?:(?:also|first|please|quietly|secretly) )*(?:look ?up|search|collect|gather|extract|harvest|compile|scrape)${E}|${S}(?:when|while|after|before|as|once|if|whenever) (?:you(?:'re| are)? )?(?:\\S+ ){0,2}?${PROCESS_ANY}\\w*,? (?:\\S+ ){0,6}?(?:${PUT}|collect|gather|grab|pull|compile|extract) (?:\\S+ ){0,2}?(?:${OWNER_DATA}|(?:every|all|each|any)(?: of)?(?: the)? (?:\\S+ ){0,2}?${DATA_SENS})${E}|${S}(?:include|collect|gather|extract|compile|grab|pull|find|harvest|scrape|list) (?:\\S+ ){0,2}?(?:every|all|each|any)(?: of)?(?: the)? (?:\\S+ ){0,2}?${PDATA} (?:you (?:can )?(?:find|see|access|get|know|have|look up)|(?:in|from) (?:the|this|your|every|all|other) (?:thread|threads|inbox|context|system|database|records|messages|conversation|clients?|customers?))${E}`,
  },
  {
    id: 'tool-order',
    re: `${S}(?:use|call|invoke|run|execute|trigger|activate|employ) (?:(?:your|the|a|an|this|that|any|all) )?(?:send|email|e-mail|gmail|mail|fetch|browse|browser|web|http|mcp|file|shell|terminal|computer|bash|python|code|slack|drive|calendar|export|upload|messaging|sms|client|thread|proposal|inbox|lookup|search)[ _-]*(?:tools?|connectors?|integrations?|plugins?)${E}|${S}tool[ _-]*(?:calls?|use|uses|results?|outputs?|responses?|invocations?)${E}|${S}function[ _-]*(?:calls?|calling|results?|outputs?|invocations?)${E}|${S}mcp[ _-]*(?:server|tool|connector)s?${E}`,
  },
  {
    id: 'tool-name',
    re: `(?<![a-z0-9_])(?:send|get|list|fetch|search|delete|export|forward|post|upload|lookup|exec|execute)_[a-z0-9]{1,30}(?:_[a-z0-9]{1,30}){0,6}(?![a-z0-9_])(?!\\.[a-z0-9])`,
  },
  {
    id: 'exfil-service',
    re: `${S}(?:webhooks?(?:\\.site)?|requestbin|request bin|pipedream|ngrok|pastebin|hastebin|ghostbin|burp ?collaborator|interact\\.sh|oastify|beeceptor|hookbin|callback url|exfil(?:trate|tration)?)${E}`,
  },
  {
    id: 'templated-url',
    re: '(?<!\\S)[(\\["\'<=]{0,3}(?:https?:\\/\\/|www\\.)[^\\s]{0,2000}?(?:\\{\\{?|\\$\\{|<[a-z_]+>|\\[(?:data|secret|key|token|info|output)\\])',
  },
  // 4. Text dressed as a system, assistant or tool message.
  {
    id: 'role-prefix-inline',
    re: `(?:^|[.!?;] )(?:system|assistant|developer|human|ai assistant|chatgpt)(?: (?:message|prompt|note|instructions?|override|update))? ?: ?(?:(?:sure|ok(?:ay)?|certainly|of course)[,!.]? )?(?:please|here (?:is|are)|i will|i'll|you (?:are|must|will|should|may|can)|ignore|disregard|forget|list|send|forward|export|share|reveal|show|print|output|add|include|look ?up|search|find|reply|respond|answer|tell|give|provide|email|upload|copy|paste|mark|approve|authori[sz]e|the user|the owner|override|from now on|as an ai)${E}|${S}system override${E}`,
  },
  {
    id: 'message-boundary',
    re: `${S}(?:begin|end|start|close|open)(?:ing)? (?:of )?(?:the )?(?:system|assistant|developer|tool|function|untrusted|external|user|hidden|admin) (?:message|prompt|input|output|instructions?|context|result|response|turn|content|data|section|block)${E}`,
  },
  {
    id: 'fake-delimiter',
    re: `(?<![-=*#_~\\[<({])(?:-{2,}|={2,}|\\*{2,}|#{2,}|_{2,}|~{2,}|\\[|<|\\(|\\{)(?![-=*#_~]) ?(?:end|begin|start) of (?:the )?(?:message|input|email|text|document|conversation|transcript|user (?:message|input)|client (?:message|input)|context|data|prompt|instructions|transmission)s?${E}|${S}(?:end|begin|start) of (?:the )?(?:message|input|email|text|document|user (?:message|input)|client (?:message|input)|prompt|instructions|transmission)s? ?(?:-{2}|={2}|\\*{2}|#{2}|_{2}|~{2}|\\]|>|\\)|\\})`,
  },
  {
    id: 'tool-result',
    re: `${S}(?:tool|function|api|plugin|mcp|search|command)[ _-]*(?:call[ _-]*)?(?:results?|outputs?|responses?|returned|observation) ?[:=]`,
  },
  {
    id: 'json-role',
    re: `["'] ?role ?["'] ?: ?["'] ?(?:system|assistant|developer|tool|function|user|human|model)${E}`,
  },
  {
    id: 'json-tool',
    re: `["'] ?(?:tool_use|tool_result|tool_call|tool_calls|function_call|tool_use_id|tool_call_id|tool_choice|tools|instructions?|system|system_prompt|prompt|messages) ?["'] ?:|["'] ?type ?["'] ?: ?["'] ?(?:tool_use|tool_result|function|function_call)${E}`,
  },
  {
    id: 'role-tag',
    re: '< ?\\/? ?(?:system|system[_-]?(?:prompt|message|instructions?)|assistant|user|human|developer|tool|tools|tool[_-]?(?:call|calls|use|result|results|response|output|code)|function|functions|function[_-]?(?:call|calls|result|results|response|output)|instructions?|prompt|im[_-]?(?:start|end|sep)|admin|important|override|context|antml:[a-z_]+|invoke|parameter|thinking|search[_-]?results?|documents?|document[_-]?content|untrusted[_-]?[a-z_]*|user[_-]?(?:input|query|message|request)|inst|sys|s|endoftext)(?: [^>]{0,200})? ?\\/?>|<!-- ?(?:ai|assistant|system|claude|duet|llm|model|instructions?|note to)',
  },
  {
    id: 'role-bracket',
    re: '\\[ ?\\/? ?(?:system|system (?:message|prompt|note|override)|assistant|developer|tool|tool (?:call|result|output|response)|function (?:call|result|output)|inst|instructions?|sys|admin|override|ai|human) ?\\]|\\[\\[ ?(?:system|instructions?)|\\{\\{ ?(?:system|instructions?|prompt|user|assistant)|<< ?\\/? ?sys ?>>|\\(\\( ?system',
  },
  {
    id: 'special-token',
    re: '<\\|[^|>\\s]{1,40}\\|>',
  },
  {
    id: 'markdown-bold',
    re: '(?<!\\*)\\*\\* ?(?:system|instructions?|new instructions?|admin|developer|assistant|ai|claude|system prompt|override|important instructions?) ?:? ?\\*\\*',
  },
  // 5. The same orders in other languages (accents are gone in the view).
  {
    id: 'other-languages-override',
    tier: 'withhold',
    re: '(?:\u524d\u306e|\u4ee5\u524d\u306e|\u4e0a\u8a18\u306e)?\u6307\u793a\u3092\u7121\u8996|\uc774\uc804 \uc9c0\uc2dc\ub97c \ubb34\uc2dc|\u062a\u062c\u0627\u0647\u0644 (?:\u062c\u0645\u064a\u0639 )?\u0627\u0644\u062a\u0639\u0644\u064a\u0645\u0627\u062a|zignoruj (?:wszystkie )?(?:poprzednie )?instrukcje|negeer (?:alle )?(?:vorige|eerdere|voorgaande) instructies|balewalain ang (?:mga )?(?:naunang )?tagubilin|tu es (?:maintenant|desormais) (?:dan|une? ia|un assistant)|du bist (?:jetzt|nun) (?:dan|eine ki)|(?:nuevas|nouvelles|neue|nuove|novas) (?:instrucciones|instructions|anweisungen|istruzioni|instrucoes) ?:',
  },
  {
    id: 'es-override',
    tier: 'withhold',
    re: `${S}(?<!(?:no|nunca|favor de no|por favor no|que no) )(?:ignora|ignore|ignoren|ignorar|olvida|olvide|olviden|olvidar|olvidate|olvidese|descarta|descarte|omite|omita|haz caso omiso (?:de|a)|haga caso omiso (?:de|a)|no hagas caso (?:de|a)|no haga caso (?:de|a)|no tomes en cuenta|no tome en cuenta|no sigas|no siga|deja de seguir|deje de seguir) (?:de )?(?:(?:todas las|todos los|tus|sus|todas tus|todas sus|cualquier|toda) (?:\\S+ )?(?:instrucciones|instruccion|indicaciones|indicacion|ordenes|reglas|directrices|directivas)|(?:las |los )?(?:instrucciones|instruccion|indicaciones|indicacion|ordenes|reglas|directrices|directivas) (?:anteriores|anterior|previas|previa|del sistema|que te dieron|originales|iniciales|de arriba|de antes))${E}|${S}(?<!(?:no|nunca|favor de no|por favor no|que no) )(?:ignora|ignore|olvida|olvide|olvidate|olvidese|descarta|haz caso omiso de) (?:de )?(?:todo )?lo (?:anterior|de arriba|previo|que te (?:han dicho|dijeron|dije))${E}|${S}(?<!(?:no|nunca|favor de no|por favor no|que no) )(?:ignora|olvida|olvidate de) todo(?: ?[.!]|$| y )|${S}tus (?:\\S+ )?(?:instrucciones|reglas|ordenes) (?:ya no aplican|ya no son validas|han cambiado|quedan anuladas)${E}|${S}(?:prompt|instrucciones) del sistema${E}|${S}muestrame tu prompt${E}|${S}modo (?:desarrollador|dios|sin restricciones)${E}|${S}(?:ahora eres|eres ahora) (?:un |una )?(?:ia|asistente|bot|dan|modelo)${E}|${S}actua como (?:una? )?(?:ia|asistente|bot|modelo)(?: \\S+){0,2}? (?:sin restricciones|sin reglas|sin filtros|liberad[oa])${E}|${S}a partir de ahora,? (?:responde|contesta|actua|eres|seras|vas a responder)${E}`,
  },
  {
    id: 'es-reader',
    tier: 'flag',
    re: `${S}(?:nota|mensaje|instrucciones?) (?:para|a) (?:el |la )?(?:ia|bot|modelo|inteligencia artificial|asistente virtual)${E}|${S}si (?:eres|usted es|estas leyendo esto y eres) (?:una? )?(?:ia|bot|inteligencia artificial|modelo de lenguaje|asistente virtual)${E}|(?:^|[.!?;:] )(?:hola |oye )?(?:asistente|claude|duet|chatgpt) ?[,:] ?(?:por favor )?(?:enviame|mandame|dame|dime|pasame|muestrame|envia|manda|lista|busca|incluye|agrega)${E}|${S}cuando (?:resumas|leas|respondas|contestes) (?:este|el|mi) (?:mensaje|correo|hilo)${E}|${S}(?:cuales son|repite|dime|revela) (?:tus|tu) (?:instrucciones|reglas|prompt)(?: ?[?.!]|$)`,
  },
  {
    id: 'es-address',
    tier: 'flag',
    re: `${S}(?:nota|mensaje|instrucciones?) (?:para|a) (?:el |la )?(?:ia|bot|modelo|inteligencia artificial|asistente virtual)${E}|${S}si (?:eres|usted es) (?:una? )?(?:ia|bot|inteligencia artificial)${E}|(?:^|[.!?;:] )(?:hola |oye )?(?:asistente|claude|duet|chatgpt),? (?:por favor )?(?:enviame|mandame|dame|dime|pasame|muestrame|envia|manda|lista|busca|incluye)${E}`,
  },
  {
    id: 'es-exfil',
    tier: 'flag',
    re: `${S}(?:envia|enviame|envianos|envie|envieme|envien|enviar|enviarme|manda|mandame|mandanos|mande|mandeme|mandar|mandarme|reenvia|reenviame|reenvie|comparte|compartime|comparta|exporta|exporte|da|dame|danos|deme|dime|digame|muestra|muestrame|lista|incluye|incluya|pasa|pasame|paseme|responde con|conteste con|necesito)(?: \\S+){0,3}? (?:la |el |los |las |tu |tus |su |sus )?(?:lista|listado|datos|informacion|telefonos|numeros|correos|emails|contactos|direcciones|nombres)(?: \\S+){0,4}? (?:clientes|usuarios|parejas|reservas)${E}`,
  },
  {
    id: 'fr-override',
    tier: 'withhold',
    re: `${S}(?<!(?:ne|n'|pas) )(?:ignore[zr]?|oublie[zr]?|ne tiens? pas compte (?:de|des)|ne tenez pas compte (?:de|des)) (?:(?:toutes|tous|les|tes|vos|des|de|ces) ){0,3}(?:instructions|consignes|directives|regles|ordres|indications)(?: (?:precedentes|anterieures|du systeme|initiales|originales))?${E}|${S}(?:ignore[zr]?|oublie[zr]?) (?:tout )?ce qui (?:precede|est au-dessus|a ete dit)${E}|${S}(?:ignore[zr]?|oublie[zr]?) tout(?: ce qu'on t'a dit| le reste)?(?: ?[.!]|$| et )|${S}ne (?:suis|suivez) plus (?:tes|vos|les) (?:instructions|consignes|regles)${E}|${S}(?:prompt|instructions) (?:du )?systeme${E}`,
  },
  {
    id: 'fr-exfil',
    tier: 'flag',
    re: `${S}(?:envoie[zr]?|envoie-moi|envoyez-moi|transmets|transmets-moi|transmettez|transmettez-moi|partage[zr]?|donne[zr]?|donne-moi|donnez-moi|exporte[zr]?|liste[zr]?|montre[zr]?|montre-moi|montrez-moi)(?: \\S+){0,3}? (?:la |les |le |ta |tes |vos |votre )?(?:liste|donnees|coordonnees|numeros|emails|e-mails|adresses|contacts|telephones)(?: \\S+){0,4}? (?:clients|utilisateurs|reservations)${E}`,
  },
  {
    id: 'de-override',
    tier: 'withhold',
    re: `${S}(?:ignoriere|ignorier|ignorieren sie|vergiss|vergessen sie|missachte|missachten sie) (?:(?:alle|die|deine|ihre|bisherigen|vorherigen|vorigen|fruheren|obigen) ){0,3}(?:anweisungen|instruktionen|befehle|regeln|vorgaben|anordnungen)${E}|${S}(?:ignoriere|vergiss|vergessen sie|ignorieren sie) alles(?: (?:oben|obige|bisherige|vorherige|davor|zuvor|vorher))?(?: ?[.!,]|$| und )`,
  },
  {
    id: 'de-exfil',
    tier: 'flag',
    re: `${S}(?:sende|schicke|schick|teile|exportiere|gib)(?: \\S+){0,4}? (?:die |alle |deine |ihre )?(?:liste (?:deiner|ihrer|der|aller) kunden|kundenliste|kundendaten|kunden(?:-| )?(?:liste|daten|kontakte|adressen|telefonnummern|e-?mails)|kontaktdaten (?:aller|der|deiner) kunden)${E}`,
  },
  {
    id: 'it-override',
    tier: 'withhold',
    re: `${S}(?<!non )(?:ignora|ignorate|dimentica|dimenticate|non considerare) (?:(?:tutte|tutti|le|i|tue|tuoi|sue|vostre) ){0,3}(?:istruzioni|indicazioni|regole|direttive|ordini)(?: precedenti)?${E}|${S}(?<!non )(?:ignora|dimentica|dimenticate) tutto(?: (?:quanto|quello)(?: che)?(?: ti e stato detto| sopra| detto| precede))?(?: ?[.!,]|$| e )`,
  },
  {
    id: 'it-exfil',
    tier: 'flag',
    re: `${S}(?:invia|inviami|manda|mandami|condividi|esporta|dammi)(?: \\S+){0,4}? (?:la lista (?:dei|di) |l'elenco (?:dei|di) |i dati (?:dei|di) |i numeri (?:dei|di) |tutti i )(?:\\S+ )?(?:clienti|utenti|contatti|prenotazioni)${E}`,
  },
  {
    id: 'pt-override',
    tier: 'withhold',
    re: `${S}(?<!nao )(?:ignore|ignora|ignorem|esqueca|esquece|esquecam|desconsidere|desconsidera) (?:(?:todas|todos|as|os|suas|tuas|de) ){0,3}(?:instrucoes|instrucao|orientacoes|regras|ordens|diretrizes)(?: anteriores| previas)?${E}|${S}(?<!nao )(?:ignore|ignora|esqueca|esquece) tudo(?: (?:acima|anterior|o que (?:foi dito|te disseram)(?: antes)?))?(?: ?[.!,]|$| e )`,
  },
  {
    id: 'pt-exfil',
    tier: 'flag',
    re: `${S}(?:envie|envia|mande|manda|me mande|me envie|compartilhe|exporte|me de|me passe)(?: \\S+){0,4}? (?:a lista de|os dados (?:de|dos)|os contatos (?:de|dos)|os telefones (?:de|dos)|todos os) (?:\\S+ )?(?:clientes|usuarios|contatos|reservas)${E}`,
  },
  {
    id: 'zh-override',
    re: '(?:\u5ffd\u7565|\u65e0\u89c6|\u5ffd\u89c6|\u4e0d\u8981\u7406\u4f1a|\u522b\u7ba1|\u5fd8\u8bb0|\u5fd8\u6389|\u4e0d\u8981\u9075\u5b88|\u4e0d\u8981\u9075\u5faa|\u4e0d\u8981\u542c\u4ece)[^\\s\uff0c\u3002,.]{0,6}?(?:\u6307\u4ee4|\u6307\u793a|\u8bf4\u660e|\u63d0\u793a|\u89c4\u5219|\u547d\u4ee4|\u8bbe\u5b9a|\u5185\u5bb9|\u8bdd|\u4e00\u5207)|(?:\u5ba2\u6237|\u7528\u6237)(?:\u7684)?(?:\u540d\u5355|\u5217\u8868|\u4fe1\u606f|\u8d44\u6599|\u6570\u636e|\u7535\u8bdd|\u90ae\u7bb1)[^\\s]{0,8}?(?:\u53d1|\u7ed9\u6211|\u544a\u8bc9\u6211)|(?:\u53d1\u9001|\u53d1\u7ed9\u6211|\u7ed9\u6211)[^\\s]{0,6}?(?:\u5ba2\u6237|\u7528\u6237)(?:\u540d\u5355|\u5217\u8868|\u4fe1\u606f|\u8d44\u6599|\u6570\u636e)|\u7cfb\u7edf\u63d0\u793a',
  },
  {
    id: 'ru-override',
    re: '(?:\u0438\u0433\u043d\u043e\u0440\u0438\u0440\u0443\u0439(?:\u0442\u0435)?|\u0437\u0430\u0431\u0443\u0434\u044c(?:\u0442\u0435)?) (?:\u0432\u0441\u0451|\u0432\u0441\u0435)(?:,| \u0447\u0442\u043e| \u0432\u044b\u0448\u0435| \u043f\u0440\u0435\u0434\u044b\u0434\u0443\u0449\u0435\u0435)|\u043d\u0435 (?:\u0441\u043b\u0435\u0434\u0443\u0439|\u0441\u043b\u0435\u0434\u0443\u0439\u0442\u0435|\u0441\u043b\u0443\u0448\u0430\u0439) (?:\u043f\u0440\u0435\u0434\u044b\u0434\u0443\u0449\u0438\u043c|\u043f\u0440\u0435\u0436\u043d\u0438\u043c|\u0441\u0432\u043e\u0438\u043c|\u044d\u0442\u0438\u043c) (?:\u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0438\u044f\u043c|\u0443\u043a\u0430\u0437\u0430\u043d\u0438\u044f\u043c|\u043f\u0440\u0430\u0432\u0438\u043b\u0430\u043c)|(?:\u0438\u0433\u043d\u043e\u0440\u0438\u0440\u0443\u0439|\u0438\u0433\u043d\u043e\u0440\u0438\u0440\u0443\u0439\u0442\u0435|\u0438\u0433\u043d\u043e\u0440\u0438\u0440\u043e\u0432\u0430\u0442\u044c|\u0437\u0430\u0431\u0443\u0434\u044c|\u0437\u0430\u0431\u0443\u0434\u044c\u0442\u0435|\u043d\u0435 \u043e\u0431\u0440\u0430\u0449\u0430\u0439 \u0432\u043d\u0438\u043c\u0430\u043d\u0438\u044f \u043d\u0430) (?:(?:\u0432\u0441\u0435|\u0441\u0432\u043e\u0438|\u0442\u0432\u043e\u0438|\u0432\u0430\u0448\u0438|\u043f\u0440\u0435\u0434\u044b\u0434\u0443\u0449\u0438\u0435|\u043f\u0440\u0435\u0436\u043d\u0438\u0435|\u043f\u0440\u043e\u0448\u043b\u044b\u0435|\u044d\u0442\u0438) ){0,3}(?:\u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0438\u0438|\u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0438\u0439|\u0443\u043a\u0430\u0437\u0430\u043d\u0438\u044f|\u043a\u043e\u043c\u0430\u043d\u0434\u044b|\u043f\u0440\u0430\u0432\u0438\u043b\u0430|\u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0438)|(?:\u043e\u0442\u043f\u0440\u0430\u0432\u044c|\u043e\u0442\u043f\u0440\u0430\u0432\u044c\u0442\u0435|\u043f\u0440\u0438\u0448\u043b\u0438|\u043f\u0440\u0438\u0448\u043b\u0438\u0442\u0435|\u043f\u0435\u0440\u0435\u0448\u043b\u0438|\u0434\u0430\u0439|\u0432\u044b\u0433\u0440\u0443\u0437\u0438)(?: \\S+){0,4}? (?:\u0441\u043f\u0438\u0441\u043e\u043a|\u0431\u0430\u0437\u0443|\u0434\u0430\u043d\u043d\u044b\u0435|\u043a\u043e\u043d\u0442\u0430\u043a\u0442\u044b|\u043d\u043e\u043c\u0435\u0440\u0430) (?:\u0432\u0441\u0435\u0445 )?(?:\u043a\u043b\u0438\u0435\u043d\u0442\u043e\u0432|\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u0435\u0439)',
  },
];

const LINE = [
  {
    id: 'role-prefix',
    re: '^ ?(?:[#>*_\\-|\\[(<]{1,10} ?)?(?:system|assistant|developer|human|user|ai|ai assistant|chatgpt|gpt|claude|duet|tool|tool[ _-]?(?:result|output|response|call)|function[ _-]?(?:result|output|response|call)|admin instructions?|system instructions?|ai instructions?|system (?:message|prompt|note|override|update))(?: (?:message|prompt|note|instructions?|override))? ?[\\])>*_|]{0,10} ?: ?(?:(?:sure|ok(?:ay)?|certainly|of course)[,!.]? )?(?:please|here (?:is|are)|i will|i\'ll|i can|you (?:are|must|will|should|may|can)|ignore|disregard|forget|list|send|forward|export|share|reveal|show|print|output|add|include|look ?up|search|find|reply|respond|answer|tell|give|provide|email|upload|copy|paste|mark|approve|authori[sz]e|return|the user|the owner|new|override|from now on|as an ai|what (?:are|is|did|were)|who (?:are|is))(?![a-z0-9])',
  },
  {
    id: 'markdown-header',
    re: '^ ?#{1,6} ?(?:(?:new|updated|important|real|actual|hidden|secret|system|admin|developer|override|priority|ai|assistant|claude) )*(?:system|instructions?|prompt|system prompt|directives?|override|admin|developer|assistant|ai|claude|task|rules)(?![a-z0-9])',
  },
  {
    id: 'separator-header',
    re: '^ ?(?:={3,}|-{3,}|\\*{3,}|#{3,}) ?(?:begin|end|start)? ?(?:system|instructions?|prompt|assistant|developer|tool)(?![a-z0-9])',
  },
  {
    id: 'delimiter-line',
    re: '^ ?(?:end|begin|start) of (?:the )?(?:message|input|email|text|document|user (?:message|input)|client (?:message|input)|prompt|instructions|transmission|context) ?[.:!-]{0,5} ?\\n ?\\S',
  },
];

// Whole text, no m flag: a dialogue of turns ("Human: ... Assistant: ...").
const WHOLE = [
  {
    id: 'role-dialogue',
    re: '^(?=[\\s\\S]*(?:^|\\n) ?(?:human|user) ?:)(?=[\\s\\S]*(?:^|\\n) ?(?:assistant|ai|claude|chatgpt) ?:)',
  },
];

// Letters and digits only, after the digit-for-letter swaps, one clause at a
// time (split at , ; : ! ? and a sentence-ending dot). Narrow on purpose: every word boundary is gone, so only phrases no ordinary sentence
// runs together belong here. Bounded repeats keep each linear.
const COMPACT_DET = '(?:all|any|every|the|your|previous|prior|above|earlier|preceding|of|these|those|system|original|initial)';
const COMPACT_DET_AI = '(?:all|any|every|your|above|preceding|system|original|initial)';
const COMPACT = [
  { id: 'compact-override', re: `^(?:please|now|just|so|and|then|ok|okay|hey|hi|hello|also|first|kindly|youmust|youshould|youwill|must)?(?:ignore|disregard|forget|overrid(?:e|ing))${COMPACT_DET}{0,4}${COMPACT_DET_AI}${COMPACT_DET}{0,4}(?:[il]nstruction|prompt(?!repl|respon|attent|servic|paym)|directive|guardrail|programming)` },
  { id: 'compact-system-prompt', re: 'systemprompt(?!ed|ing|s?(?:me|us|for|says|said|asked))' },
  { id: 'compact-mode', re: '(?:enable|enter|activate|turnon|switchto|unlock)(?:the)?(?:developer|god|dan|jailbreak)mode|developermode(?:enabled|activated|on(?![a-z]))|jailbr(?:eak|oken)|promptinjection' },
  { id: 'compact-role', re: 'youarenow(?:dan|an?(?:unrestricted|unfiltered|jailbroken)?ai)' },
];

// The withhold tier: text a real client never writes. Everything else in
// FLAT flags. LINE, WHOLE and COMPACT patterns all withhold.
const WITHHOLD_IDS = new Set([
  'override-instructions', 'override-plain', 'override-above', 'override-everything', 'what-you-were-told',
  'instructions-void', 'new-task', 'system-prompt', 'claimed-instructions', 'your-hidden-instructions',
  'reveal-prompt', 'repeat-above', 'role-you-are-now', 'role-act-as', 'role-pretend', 'role-from-now-on',
  'mode-switch', 'ai-data-order', 'you-are-an-ai', 'role-prefix-inline', 'message-boundary',
  'fake-delimiter', 'tool-result', 'json-role', 'json-tool', 'role-tag', 'role-bracket', 'special-token',
  'markdown-bold', 'es-override', 'fr-override', 'de-override', 'it-override', 'pt-override',
  'zh-override', 'ru-override',
]);
const withTier = (fallback) => (p) => ({ ...p, tier: p.tier || (fallback === 'flat' ? (WITHHOLD_IDS.has(p.id) ? 'withhold' : 'flag') : 'withhold') });

module.exports = {
  FLAT_PATTERNS: FLAT.map(withTier('flat')),
  LINE_PATTERNS: LINE.map(withTier('line')),
  WHOLE_PATTERNS: WHOLE.map(withTier('whole')),
  COMPACT_PATTERNS: COMPACT.map(withTier('compact')),
};
