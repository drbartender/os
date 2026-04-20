// server/data/contractorAgreement.js

const CURRENT_VERSION = 'contractor-agreement-v2';

const V2 = {
  version: 'contractor-agreement-v2',
  effective_date: '2026-04-20',

  at_a_glance: [
    "You're an independent contractor, not an employee — you run your own business.",
    "Each event is its own gig. You choose which to accept; once you commit, you're expected to complete it.",
    "You're paid for actual hours worked plus any gratuity. You handle your own taxes.",
    "Dr. Bartender issues a 1099 only if your annual earnings cross the IRS threshold.",
    "You can't solicit Dr. Bartender's clients, venues, or other contractors — during your time with us and for 12 months after.",
    "If you damage our equipment through willful misconduct or gross negligence, we may recoup the cost. Ordinary accidents aren't subject to that.",
  ],

  clauses: [
    {
      number: 1,
      title: 'Independent Contractor Relationship',
      plain: "In plain English: you're your own boss. We tell you what the job is, not how to do it.",
      formal: "Contractor is an independent contractor providing the Services, which are outside the Company's usual course of business. Nothing in this Agreement will be construed as establishing an employment or agency relationship between Company and Contractor. Contractor has no authority to bind Company by contract or otherwise. Contractor will perform Services under the general direction of Company, but Contractor will determine the manner and means by which Services are accomplished. Dr. Bartender does not control the way in which Services are performed but has discretion to determine whether the final product is acceptable."
    },
    {
      number: 2,
      title: 'Each Event Is a Separate Project',
      plain: "In plain English: each gig stands on its own. You're free to apply, accept, or decline any event — but once you commit, you're expected to see it through.",
      formal: "Each assignment constitutes a separate \"project\" governed by the event specifics and needs as outlined in the applicable event application. Contractor is free to apply for any event, and to accept or decline any assignment; however, Contractor is expected to carry out any events to which Contractor has committed."
    },
    {
      number: 3,
      title: 'Compensation & Taxes',
      plain: "In plain English: you're paid for hours worked plus tips. You cover your own taxes. We'll issue a 1099 if you cross the IRS threshold.",
      formal: "Contractor will be compensated for actual hours worked plus applicable gratuity, as set out in each engagement. Additional time must be pre-approved by Company to be compensable. Contractor is solely responsible for all federal, state, and local taxes on amounts received under this Agreement. Company will issue IRS Form 1099 (or its then-current equivalent) if total calendar-year payments to Contractor exceed the applicable IRS reporting threshold. Contractor acknowledges that Contractor is not entitled to employee benefits (including health insurance, retirement plans, paid time off, workers' compensation, or unemployment) from Company."
    },
    {
      number: 4,
      title: 'Tools, Equipment & Damage Recoupment',
      plain: "In plain English: bring your own kit. If we loan you gear and you damage it through willful misconduct or gross negligence, we may recoup the cost. Ordinary accidents are on us.",
      formal: "Contractor will supply, at Contractor's own expense, all materials, supplies, equipment, and tools required to provide the Services and accomplish the work agreed to be performed under this Agreement, except where Company has agreed in writing to provide specific items. Contractor is responsible for the reasonable replacement cost of Company-provided equipment or product damaged through Contractor's willful misconduct or gross negligence. Company may, at its discretion, deduct such costs from unpaid amounts owed to Contractor or invoice Contractor directly. Ordinary accidents and normal wear and tear are not subject to recoupment."
    },
    {
      number: 5,
      title: 'Non-Solicitation',
      plain: "In plain English: while you're working with us — and for one year after — you don't poach our clients, venues, or other contractors for your own side work.",
      formal: "During the term of this Agreement and for a period of one (1) year thereafter, Contractor will not, directly or indirectly, solicit the services of any Company personnel or other contractors, or directly or indirectly attempt to solicit any Company clients, for Contractor's own benefit or for the benefit of any other person or entity."
    },
    {
      number: 6,
      title: 'Representations & Warranties',
      plain: "In plain English: we each confirm we're legit and can enter this contract. You also confirm your work is professional, is yours, and doesn't step on anyone else's rights.",
      formal: "**Mutual.** Each party represents and warrants to the other that: (a) it has the legal power and authority to enter into this Agreement; and (b) it will comply with all applicable laws in performing its obligations under this Agreement.\n\n**From Contractor.** Contractor represents and warrants to Company that:\n• Contractor will perform the Services in a timely, competent, and professional manner, consistent with high professional and industry standards, with the requisite training, background, experience, technical knowledge, and skills to perform the Services;\n• Contractor has no pre-existing obligations or commitments (and will not assume or otherwise undertake any obligations or commitments) that would be in conflict or inconsistent with, or that would hinder Contractor's performance of, Contractor's obligations under this Agreement;\n• the Work Product does not and will not infringe or misappropriate anyone else's patent, copyright, trademark, trade secret, right of privacy or publicity, or other intellectual or proprietary right;\n• the Work Product will conform to the requirements of the applicable event or engagement; and\n• Contractor has all rights necessary — including all federal, state, and local business permits and licenses, and any applicable alcohol-service certification (BASSET, TIPS, ServSafe Alcohol, or equivalent) — to perform the Services."
    },
    {
      number: 7,
      title: 'Indemnification',
      plain: "In plain English: if a third party sues Dr. Bartender because of something you did, you cover it.",
      formal: "Contractor will indemnify and hold harmless Company from and against all claims, damages, losses, and expenses, including court costs and reasonable attorneys' fees, arising out of or resulting from, and, at Company's option, Contractor will defend Company against any action by a third party against Company that is based on:\n• a claim that any Service, the results of any Service (including any Work Product), or Company's use thereof, infringes, misappropriates, or violates a third party's intellectual property rights;\n• a breach or alleged breach by Contractor of Section 6 (Representations & Warranties); or\n• any negligent act or omission, or reckless or willful conduct, of Contractor that results in (i) bodily injury, sickness, disease, or death; (ii) injury to or destruction of tangible or intangible property (including computer programs and data) or any loss of use resulting therefrom; or (iii) the violation of any applicable laws."
    },
    {
      number: 8,
      title: 'Limitation of Liability',
      plain: "In plain English: Dr. Bartender isn't on the hook for lost profits or other indirect damages, even if informed about the possibility.",
      formal: "Under no circumstances will Company be liable for lost profits or revenues (whether direct or indirect), or for consequential, special, indirect, exemplary, punitive, or incidental damages relating to this Agreement, even if Company is informed of the possibility of these types of damages in advance."
    },
    {
      number: 9,
      title: 'Assignment',
      plain: "In plain English: you can't hand this contract off to someone else. Dr. Bartender can, if the business is sold.",
      formal: "Contractor may not assign or transfer any of Contractor's rights or delegate any of Contractor's obligations under this Agreement, in whole or in part, without Company's express prior written consent. Any attempted assignment, transfer, or delegation without such consent will be void. Company may assign or transfer this Agreement in connection with the sale of all or substantially all of its business or assets to which this Agreement relates. Subject to the foregoing, this Agreement will be binding upon and will inure to the benefit of the parties' permitted successors and assigns."
    },
    {
      number: 10,
      title: 'Modifications, Severability & Waiver',
      plain: "In plain English: changes must be in writing. If a court tosses one clause, the rest still holds.",
      formal: "Any waiver, modification, or change to this Agreement must be in writing and signed or electronically accepted by each party. If any term of this Agreement is determined to be invalid or unenforceable by a relevant court or governing body, the remaining terms of this Agreement will remain in full force and effect. The failure of a party to enforce a term, or to exercise an option or right, in this Agreement will not constitute a waiver by that party of the term, option, or right."
    },
    {
      number: 11,
      title: 'Field Guide Compliance',
      plain: "In plain English: you've read the Field Guide and will follow the protocols in it (appearance, timing, sobriety, alcohol laws, incident reporting, etc.).",
      formal: "Contractor acknowledges having read and understood the Dr. Bartender Field Guide, which sets out operational expectations including appearance, tools, timing, tips, boundaries, alcohol-service laws, sobriety policy, incident reporting, social media, and harassment policies. Compliance with the Field Guide is a condition of performing Services under this Agreement. The Company may update the Field Guide from time to time; material changes will be communicated to Contractor."
    }
  ],

  acknowledgments: [
    { key: 'ack_ic_status',         label: 'I am working with Dr. Bartender as an independent contractor, not an employee, and am responsible for my own taxes.' },
    { key: 'ack_commitment',        label: 'If I accept an event assignment, I will complete it to professional standards with my own tools.' },
    { key: 'ack_non_solicit',       label: "I will not solicit Dr. Bartender's clients, venues, or other contractors during my time with the company or for 12 months after." },
    { key: 'ack_damage_recoupment', label: 'I understand Dr. Bartender may recoup the replacement cost of company-provided equipment I damage through willful misconduct or gross negligence.' },
    { key: 'ack_legal_protections', label: 'I have read and agree to Sections 6, 7, and 8 above (Representations & Warranties, Indemnification, Limitation of Liability).' },
    { key: 'ack_field_guide',       label: 'I have read the Dr. Bartender Field Guide and will follow its protocols.' },
  ],
};

const VERSIONS = {
  'contractor-agreement-v2': V2,
};

function getCurrentAgreement() {
  return VERSIONS[CURRENT_VERSION];
}

function getAgreementVersion(version) {
  return VERSIONS[version] || null;
}

module.exports = {
  CURRENT_VERSION,
  VERSIONS,
  getCurrentAgreement,
  getAgreementVersion,
};
