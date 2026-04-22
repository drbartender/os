# Dr. Bartender - Pricing System Tutorial & Reference

**Prepared:** April 4, 2026

---

## Table of Contents

1. [How Pricing Works (Overview)](#how-pricing-works-overview)
2. [Package Categories](#package-categories)
3. [BYOB Packages](#byob-packages-client-provides-alcohol)
4. [Hosted Full Bar Packages](#hosted-full-bar-packages)
5. [Hosted Beer & Wine Packages](#hosted-beer--wine-packages)
6. [Hosted Mocktail Package](#hosted-mocktail-package)
7. [Bar Rental Fees](#bar-rental-fees)
8. [Staffing & Bartender Calculations](#staffing--bartender-calculations)
9. [Add-Ons](#add-ons)
10. [How Add-On Billing Types Work](#how-add-on-billing-types-work)
11. [How a Proposal Total Is Calculated](#how-a-proposal-total-is-calculated)
12. [Worked Examples](#worked-examples)
13. [Payments & Deposits](#payments--deposits)
14. [What Every Package Includes](#what-every-package-includes)

---

## How Pricing Works (Overview)

Every Dr. Bartender proposal is built from four pricing components that are added together:

```
TOTAL = Base Package Cost + Bar Rental + Extra Staffing + Add-Ons
```

The system calculates this automatically when a proposal is created or updated. Here's how each component works.

---

## Package Categories

Packages are divided into two main categories:

| Category | What It Means | Pricing Model |
|----------|---------------|---------------|
| **BYOB** | Client provides the alcohol. We provide service, tools, and expertise. | **Flat rate** based on event duration |
| **Hosted** | We provide everything -- alcohol, mixers, garnishes, and service. | **Per-guest rate** based on guest count and duration |

Within Hosted, there are three bar types:
- **Full Bar** - Spirits, beer, wine, mixers
- **Beer & Wine** - Beer and wine only, no spirits
- **Mocktail** - Non-alcoholic cocktails only

---

## BYOB Packages (Client Provides Alcohol)

BYOB packages use **flat-rate pricing**. The price is based on duration only -- guest count does not affect the base price.

### How BYOB Pricing Works

```
If event <= 3 hours:  use the 3-hour rate (if available)
If event <= 4 hours:  use the 4-hour rate
If event > 4 hours:   4-hour rate + (extra hours x extra hour rate)
```

### The Core Reaction -- Service Only

| Duration | Price |
|----------|-------|
| Up to 4 hours | $350 |
| Each extra hour | +$100 |
| 5-hour event | $450 |
| 6-hour event | $550 |

**What's included:** Professional bartender, setup & breakdown, cooler, bar tools, clean service layout, menu planning session, precise alcohol shopping list, bespoke menu graphic, $2M insurance.

**What the client provides:** All alcohol and supplies (or they can follow our custom shopping list).

**Bar type:** Service Only -- no liquor, beer, or wine provided by us.

---

### Mixology Classes (6 classes, per-guest pricing)

All classes: **$35/person**, 2 hours, 8-20 guests, 1 instructor, digital recipe cards via QR code, $2M insurance included. Pricing follows the hosted per-guest model even though clients BYOB by default — the $35 is for instruction, equipment, and class materials, not alcohol. Full spec lives in `dr-bartender-class-menu.md`.

| Class | Slug | Supply Add-on |
|-------|------|---------------|
| Mixology 101 | `mixology-101` | $25/person |
| Spirits Tasting (Whiskey/Bourbon OR Tequila/Mezcal) | `spirits-tasting` | Standard $30 / Premium $45 / Top Shelf custom |
| Margarita Workshop | `margarita-workshop` | $25/person |
| Tropical / Tiki Night | `tropical-tiki-night` | $30/person |
| Brunch Cocktails | `brunch-cocktails` | $30/person |
| Mocktail Workshop | `mocktail-workshop` | $15/person |

**Universal class equipment add-ons (mutually exclusive):**
- Tool Kit Purchase — $55/person (A Bar Above kit, guests keep)
- Tool Kit Rental — $10/person

**Top Shelf tier (Spirits Tasting only):** wizard submits `class_options.top_shelf_requested = true`; server creates a **draft** proposal with no total and emails admin for manual pricing. Client sees "we'll follow up with custom pricing" on the wizard success screen — no client email goes out until admin sends the priced proposal.

**Bar type:** Class -- hands-on instruction, not event service. Wizard filters `bar_type = 'class'`.

---

## Hosted Full Bar Packages

Hosted packages use **per-guest pricing**. The price scales with guest count.

### How Hosted Pricing Works

```
If event <= 4 hours:  guest count x 4-hour rate per guest
If event > 4 hours:   (guest count x 4-hour rate) + (guest count x extra hours x extra hour rate)
```

### Small Event Pricing (Under 50 Guests)

Events with fewer than 50 guests use higher per-guest rates. This is because fixed costs (setup, equipment, travel, bartender time) don't scale down proportionally for smaller events.

```
If guest count < 50:  use the "small event" rates instead
If guest count >= 50: use the standard rates
```

### Full Bar Package Comparison

| Package | Standard 4-Hr | Standard Extra Hr | Small (<50) 4-Hr | Small (<50) Extra Hr |
|---------|---------------|--------------------|--------------------|------------------------|
| **The Base Compound** | $18/guest | $5/guest/hr | $23/guest | $5/guest/hr |
| **The Midrange Reaction** | $22/guest | $6/guest/hr | $27/guest | $6/guest/hr |
| **The Enhanced Solution** | $28/guest | $8/guest/hr | $33/guest | $8/guest/hr |
| **Formula No. 5** | $33/guest | $9/guest/hr | $39/guest | $9/guest/hr |
| **The Grand Experiment** | $40/guest | $11.25/guest/hr | $46/guest | $11.25/guest/hr |

---

### The Base Compound

Entry-level hosted bar. Pre-formulated signature cocktails for fast, reliable service.

**Drinks included:**
- 2 Signature Cocktails (pre-batched)
- Miller Lite, Michelob Ultra
- One Red Wine, One White Wine
- Bottled Water

---

### The Midrange Reaction

Expanded spirit selection with full mixer range. Ideal for weddings and milestone events.

**Drinks included:**
- Svedka Vodka, New Amsterdam Gin, Bacardi Superior Rum, Jim Beam Bourbon, Margaritaville Tequila, Dewar's Scotch
- Miller Lite, Michelob Ultra
- One Red Wine, One White Wine
- Coke, Diet Coke, Sprite, Soda Water, Tonic
- Cranberry, Orange, Pineapple Juices
- Bottled Water

---

### The Enhanced Solution

Premium spirits with expanded modifiers.

**Drinks included:**
- Six premium spirits
- Three beers
- Four wines + Sparkling wine
- Expanded mixers/modifiers including bitters and citrus juices

---

### Formula No. 5

Top-shelf spirits, deliberate curation. Quality over quantity.

**Drinks included:**
- Grey Goose Vodka, Hendrick's Gin, Appleton Estate Rum, Casamigos Tequila, Bulleit Bourbon
- Stella Artois
- One Red Wine, One White Wine
- Coke, Diet Coke, Sprite, Ginger Ale, Soda, Tonic
- Orange, Cranberry, Pineapple Juices
- Simple Syrup & Bitters
- Bottled Water

---

### The Grand Experiment

Top-tier everything. No corners cut.

**Drinks included:**
- Nine spirits
- Three beers + Craft beer selection
- Four premium wines + Sparkling wine
- Full mixer/modifier range including fresh citrus

---

## Hosted Beer & Wine Packages

Same per-guest pricing model as full bar, but no spirits.

| Package | Standard 4-Hr | Standard Extra Hr | Small (<50) 4-Hr | Small (<50) Extra Hr |
|---------|---------------|--------------------|--------------------|------------------------|
| **The Primary Culture** | $12/guest | $4/guest/hr | $17/guest | $4/guest/hr |
| **The Refined Reaction** | $14/guest | $5/guest/hr | $19/guest | $5/guest/hr |
| **The Carbon Suspension** | $15/guest | $5.75/guest/hr | $20/guest | $5.75/guest/hr |
| **The Cultivated Complex** | $17/guest | $6.25/guest/hr | $22/guest | $6.25/guest/hr |

### The Primary Culture
Miller Lite, Michelob Ultra, one red & one white wine, infused water station.

### The Refined Reaction
Stella Artois, Corona Extra, one red & one white wine, sparkling wine, bottled water.

### The Carbon Suspension
Miller Lite, Michelob Ultra, Yuengling Lager, rotating seltzer flavors, two red & two white wines, bottled water.

### The Cultivated Complex
Miller Lite, Michelob Ultra, Yuengling Lager, two rotating craft/local beers, seasonal seltzer, two premium red & two premium white wines, sparkling wine, bottled water.

---

## Hosted Mocktail Package

| Package | Standard 4-Hr | Standard Extra Hr | Small (<50) 4-Hr | Small (<50) Extra Hr |
|---------|---------------|--------------------|--------------------|------------------------|
| **The Clear Reaction** | $14/guest | $4/guest/hr | $18/guest | $4/guest/hr |

### The Clear Reaction
3-4 signature mocktail recipes with all mixers, garnishes, and syrups. Perfect for corporate events, baby showers, religious/cultural events, or sober-curious crowds.

---

## Bar Rental Fees

If the client needs us to bring a physical bar setup:

| Item | Fee |
|------|-----|
| First bar | $50 |
| Each additional bar | $100 |

**Example:** 2 bars = $50 + $100 = **$150**
**Example:** 3 bars = $50 + $100 + $100 = **$250**

If the client has their own bar or doesn't need one, this fee is $0.

---

## Staffing & Bartender Calculations

### How Bartender Count Is Determined

The system recommends **1 bartender per 100 guests**:

| Guests | Recommended Bartenders |
|--------|----------------------|
| 1-100 | 1 |
| 101-200 | 2 |
| 201-300 | 3 |

The admin can override this number when creating a proposal.

### Extra Bartender Costs

Every package includes **1 bartender**. Extra bartenders are handled differently depending on the package category:

| Category | Extra Bartender Cost |
|----------|---------------------|
| **BYOB** | $40/hr per extra bartender (charged as a separate line item) |
| **Hosted** | **Included in the per-guest rate** (no additional charge) |

**BYOB Example:** 200 guests, 5-hour event, 2 bartenders needed:
- 1 extra bartender x 5 hours x $40/hr = **$200 extra staffing charge**

**Hosted Example:** 200 guests with The Base Compound:
- 2 bartenders needed, but cost is already factored into the $18/guest rate
- No separate staffing charge

---

## Add-Ons

### BYOB Supply Add-Ons

Only available when a BYOB package is selected. These are the supplies/mixers the client would otherwise need to provide themselves.

#### Tiered Supply Bundles (Choose One)

These three bundles are cumulative -- each tier includes everything in the tier below it:

| Tier | Add-On | Rate | Extra Hr Rate | What It Adds |
|------|--------|------|---------------|--------------|
| 1 | **The Foundation** | $3.00/guest | +$0.75/guest/hr | Ice, bottled water, premium cups, napkins, stir sticks |
| 2 | **The Formula** | $5.50/guest | +$1.25/guest/hr | + Mixers for signature cocktails, basic garnishes, simple syrup, bitters |
| 3 | **The Full Compound** | $8.00/guest | +$2.00/guest/hr | + Complete mixer selection, premium garnish package |

#### A La Carte Supply Options

For clients who only need specific items:

| Add-On | Rate | Description |
|--------|------|-------------|
| **Ice Delivery Only** | $2.00/guest | Ice delivery |
| **Cups & Disposables Only** | $1.50/guest | Premium cups, napkins, stir sticks, straws |
| **Bottled Water Only** | $0.50/guest | Bottled water |
| **Signature Mixers Only** | $2.00/guest | Mixers for signature cocktails (no Foundation items) |
| **Full Mixers Only** | $4.50/guest | Complete mixer selection (no Foundation items) |
| **Garnish Package Only** | $50.00 flat | Lemons, limes, oranges, cherries, olives |

---

### Universal Add-Ons

Available for **all** package types (BYOB and Hosted).

| Add-On | Billing | Rate | Extra Hr Rate | Description |
|--------|---------|------|---------------|-------------|
| **Champagne Toast** | Per guest | $2.50/guest | -- | Champagne toast for all guests |
| **Single Pre-Batched Mocktail** | Per guest | $1.50/guest | -- | One pre-batched mocktail option |
| **Soft Drink Add-On** | Per guest | $3.00/guest | -- | Soft drinks for all guests |
| **Mocktail Bar** | Per guest (timed) | $7.50/guest | +$2.00/guest/hr | Full mocktail bar with signature recipes |
| **Banquet Server** | Per hour | $75.00/hr | -- | Professional banquet server |
| **Flavor Blaster Rental** | Flat | $150.00 | -- | Flavor blaster equipment rental |
| **Handcrafted Syrups** | Flat | $30.00 | -- | Single 750ml bottle |
| **Handcrafted Syrups 3-Pack** | Flat | $75.00 | -- | Three 750ml bottles |
| **Parking Fee** | Flat | $20.00 | -- | Per bartender |

---

## How Add-On Billing Types Work

Each add-on uses one of four billing methods:

### Flat Rate
A single fixed fee. Guest count and duration don't matter.

```
Cost = rate
Example: Flavor Blaster Rental = $150.00
```

### Per Guest
Multiplied by the number of guests. Duration doesn't matter.

```
Cost = rate x guest count
Example: Champagne Toast for 100 guests = $2.50 x 100 = $250.00
```

### Per Guest (Timed)
Base rate covers 4 hours. Each additional hour adds an extra per-guest charge.

```
If event <= 4 hours:  Cost = rate x guest count
If event > 4 hours:   Cost = (rate x guest count) + (extra hours x extra hour rate x guest count)
```

```
Example: The Foundation for 80 guests, 6-hour event
  Base: $3.00 x 80 = $240.00
  Extra hours: 2 hrs x $0.75 x 80 = $120.00
  Total: $360.00
```

### Per Hour
Multiplied by event duration. Guest count doesn't matter.

```
Cost = rate x duration hours
Example: Banquet Server for 5 hours = $75.00 x 5 = $375.00
```

Some per-hour add-ons have a minimum hours requirement -- if the event is shorter than the minimum, the minimum hours are used for billing.

---

## How a Proposal Total Is Calculated

Here is the exact formula the system uses, step by step:

### Step 1: Base Package Cost

**BYOB (flat pricing):**
```
if duration <= 3hrs AND 3hr rate exists:  base = 3hr rate
else if duration <= 4hrs:                 base = 4hr rate
else:                                     base = 4hr rate + (duration - 4) x extra hour rate
```

**Hosted (per-guest pricing):**
```
if guest count < 50:  use small event rates
else:                 use standard rates

if duration <= 4hrs:  base = guest count x 4hr rate
else:                 base = (guest count x 4hr rate) + (guest count x (duration - 4) x extra hour rate)
```

### Step 2: Bar Rental
```
if no bars needed:  $0
else:               $50 (first bar) + $100 x (additional bars)
```

### Step 3: Extra Staffing (BYOB Only)
```
required bartenders = ceil(guest count / 100)
extra bartenders = max(0, actual bartenders - 1 included)

BYOB:   extra staffing = extra bartenders x duration x $40/hr
Hosted: extra staffing = $0 (included in per-guest rate)
```

### Step 4: Add-Ons
Each selected add-on is calculated using its billing type (see above), then summed.

### Step 5: Total
```
TOTAL = base cost + bar rental + extra staffing + sum of all add-ons
```

---

## Worked Examples

### Example 1: Budget BYOB Wedding (100 guests, 5 hours)

| Line Item | Calculation | Amount |
|-----------|-------------|--------|
| The Core Reaction (5hrs) | $350 + (5-4) x $100 | $450.00 |
| Bar Rental (1 bar) | $50 | $50.00 |
| Extra Staffing | 1 bartender needed, 1 included = 0 extra | $0.00 |
| The Foundation (supplies) | $3.00 x 100 guests + 1hr x $0.75 x 100 | $375.00 |
| **TOTAL** | | **$875.00** |

### Example 2: Midrange Wedding (150 guests, 5 hours)

| Line Item | Calculation | Amount |
|-----------|-------------|--------|
| The Midrange Reaction (5hrs, 150 guests) | (150 x $22) + (150 x 1 x $6) | $4,200.00 |
| Bar Rental (2 bars) | $50 + $100 | $150.00 |
| Extra Staffing | Hosted = included | $0.00 |
| Champagne Toast | $2.50 x 150 | $375.00 |
| **TOTAL** | | **$4,725.00** |

### Example 3: Premium Corporate Event (75 guests, 4 hours)

| Line Item | Calculation | Amount |
|-----------|-------------|--------|
| Formula No. 5 (4hrs, 75 guests) | 75 x $33 | $2,475.00 |
| Bar Rental (1 bar) | $50 | $50.00 |
| Extra Staffing | Hosted = included | $0.00 |
| Soft Drink Add-On | $3.00 x 75 | $225.00 |
| Flavor Blaster Rental | Flat | $150.00 |
| **TOTAL** | | **$2,900.00** |

### Example 4: Small Intimate Dinner (30 guests, 3 hours)

Note: Under 50 guests triggers the small event rates.

| Line Item | Calculation | Amount |
|-----------|-------------|--------|
| The Base Compound (3hrs, 30 guests, SMALL) | No 3hr rate, so: 30 x $23 | $690.00 |
| Bar Rental (0 bars) | Client has own bar | $0.00 |
| **TOTAL** | | **$690.00** |

### Example 5: Mixology 101 class (10 guests, 2 hours, BYOB + Tool Kit Rental)

| Line Item | Calculation | Amount |
|-----------|-------------|--------|
| Mixology 101 | 10 × $35/person | $350.00 |
| Tool Kit Rental | 10 × $10/person | $100.00 |
| **TOTAL** | | **$450.00** |

### Example 6: Spirits Tasting — Whiskey & Bourbon, Standard (12 guests)

| Line Item | Calculation | Amount |
|-----------|-------------|--------|
| Spirits Tasting | 12 × $35/person | $420.00 |
| Standard Tier Spirits | 12 × $30/person | $360.00 |
| **TOTAL** | | **$780.00** |

---

## Payments & Deposits

Once a proposal is created and sent to the client, the payment flow works as follows:

### Proposal Lifecycle

```
draft -> sent -> viewed -> accepted -> deposit_paid -> balance_paid -> confirmed -> completed
```

### Payment Options

When a client is ready to pay, there are two options:

| Option | What Happens |
|--------|-------------|
| **Deposit** | Client pays $100 deposit up front. Remaining balance is due later. |
| **Full Payment** | Client pays the entire proposal total at once. |

### How Deposits Work

- Default deposit amount: **$100.00** (configurable via `STRIPE_DEPOSIT_AMOUNT` env var, value in cents)
- Deposits are collected via **Stripe Checkout**
- After deposit is paid, proposal status moves to `deposit_paid`
- After full balance is paid, status moves to `balance_paid`
- The system tracks `amount_paid` against `total_price` to determine payment status

### Payment Tracking

The system tracks:
- `total_price` -- the calculated proposal total
- `deposit_amount` -- the required deposit (default $100)
- `amount_paid` -- how much has been paid so far
- Individual payment records in the `proposal_payments` table (each with Stripe payment intent ID)

### Autopay

Clients can enroll in autopay during the deposit flow. If enabled, the remaining balance is automatically charged using the payment method from their deposit.

---

## What Every Package Includes

Regardless of which package is selected, all events come with:

- Professional bartender(s)
- Full setup and breakdown
- Cooler
- Custom menu graphic
- $2 million liquor liability insurance

BYOB packages additionally include:
- Bar tools and clean service layout
- Menu planning session
- Precise, event-specific alcohol shopping list

---

*This report reflects current pricing as configured in the Dr. Bartender system. For the most up-to-date rates, check the admin dashboard under Proposals > Packages.*
