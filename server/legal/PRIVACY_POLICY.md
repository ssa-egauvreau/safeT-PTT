# safeT PTT — Privacy Policy

> **DRAFT — NOT LEGAL ADVICE.** This is a working draft prepared from a review of
> the platform's source code. It must be completed (every `[PLACEHOLDER]`) and
> reviewed by qualified counsel before publication. See
> `LEGAL_RISK_REVIEW.md` — several findings (recording consent, retention,
> security defaults, access control) must be addressed for the statements below
> to be accurate.

**Effective date:** [EFFECTIVE DATE]
**Last updated:** [DATE]

## 1. Introduction

This Privacy Policy explains how [LEGAL ENTITY NAME] ("**safeT PTT**," "**we**,"
"**us**") collects, uses, discloses, and protects information in connection with
the safeT PTT push-to-talk platform, including the safeT Mobile handset app,
the safeT Command web dispatch console, the safeT Command desktop application,
and the supporting backend services (together, the "**Service**").

safeT PTT is an **enterprise** product. It is licensed to organizations
("**Customers**") — for example, security firms, agencies, and other employers —
that make it available to their personnel ("**Authorized Users**," such as
field officers, dispatchers, and administrators). It is **not** offered to, or
intended for, the general public or anyone under 18.

## 2. Our role: controller vs. service provider

For most information processed through the Service, the **Customer** decides why
and how the information is processed. In that case the Customer is the
**business / controller** and safeT PTT acts as a **service provider /
processor**, handling that information only on the Customer's documented
instructions and under our agreement with the Customer (the Terms of Service and
any Data Processing Addendum). Authorized Users who have questions about that
information should contact their organization first.

safeT PTT acts as a **business / controller** for a limited set of information
that we determine the purposes for — for example, Customer administrator contact
details, billing information, and support correspondence.

This Policy describes our practices in both roles. Where the Customer is the
controller, the Customer's own privacy notice also applies and governs the
relationship with its personnel.

## 3. Information we collect

### 3.1 Account and identity information
- Username, display name, assigned role (administrator, dispatcher, radio), and
  a numeric account ID.
- Radio "unit ID" and any friendly unit alias label.
- A salted, hashed password (we store a bcrypt hash; we do **not** store
  passwords in plain text).
- Channel assignments and per-channel permissions.

### 3.2 Voice transmissions (recordings)
The Service **records each push-to-talk transmission** ("talk-spurt") on the
channels it serves. For each recording we store: the audio (WAV), the channel,
the speaking user and/or unit ID and display name, start and end time, and
duration.

### 3.3 Transcripts
Recorded transmissions are processed by an automatic speech-recognition model to
produce a **text transcript**, which is stored with the recording and is
searchable in the dispatch console. Transcripts are **machine-generated and
best-effort**; they may contain errors and are not an authoritative record. The
audio recording is the source of record.

### 3.4 Location information
When location reporting is enabled, the handset app reports the device's
**precise GPS location** (latitude, longitude, accuracy, heading, and speed) to
the Service at regular intervals while the app is running, so the device's
position can be shown on the dispatch map. The Service stores the **most recent
known position** for each unit. Precise geolocation is treated as **sensitive
personal information**.

### 3.5 Presence and channel activity
Which units are present on which channels, and which unit is currently
transmitting, for live status displays.

### 3.6 Alerts
Emergency activations and pages, including the originating unit/user, target,
channel, message text, and the time raised and cleared.

### 3.7 Audit and technical logs
Administrative and security events (for example logins, failed logins, account
and channel changes), each recorded with the actor, action, target, time, and
the **IP address** of the request. We and our hosting providers may also collect
standard server and diagnostic logs.

### 3.8 Device and connection information
Device and operating-system characteristics, network information, and app
version, collected to operate and troubleshoot the Service.

### 3.9 Support information
Information you provide when you contact us for support, including your contact
details and the contents of your communications.

We do **not** intentionally collect special categories of data beyond what is
described here, and the Service is not designed to collect payment card data
from Authorized Users.

## 4. How we use information

We use information to:
- provide, operate, secure, and maintain the Service, including voice relay,
  recording, transcription, presence, mapping, and alerting;
- authenticate users and enforce roles, channel permissions, and access
  controls;
- create and maintain transmission logs and audit trails for the Customer;
- detect, investigate, and prevent security incidents, fraud, and misuse;
- provide customer support and communicate about the Service;
- comply with legal obligations and enforce our agreements; and
- maintain and improve the reliability and performance of the Service.

When we act as a service provider/processor, we use Customer information only as
needed to provide the Service and on the Customer's instructions. We do **not**
sell personal information and we do **not** "share" it for cross-context
behavioral advertising. We do not use Customer recordings, transcripts, or
location data to train AI models for unrelated purposes.

## 5. How information is disclosed

We disclose information only as follows:

- **To the Customer.** Recordings, transcripts, locations, presence, alerts,
  audit logs, and account data are made available to the Customer organization
  and to the administrators and dispatchers it authorizes.
- **To subprocessors.** We use vendors to host and operate the Service. See
  Section 9.
- **For legal reasons.** When required by law, regulation, legal process, or a
  valid government request, or to protect the rights, safety, or property of
  safeT PTT, our Customers, Authorized Users, or others. Where we are a service
  provider and lawfully able, we will direct the requesting party to the
  Customer and/or notify the Customer.
- **In a business transfer.** In connection with a merger, acquisition,
  financing, or sale of assets, subject to this Policy.
- **With consent.** With the relevant party's consent or at their direction.

## 6. Recording and transcription notice

Because the Service records and transcribes voice communications, recording and
monitoring may be subject to federal and state wiretap, eavesdropping, and
consent laws, which vary by jurisdiction and in some states require the consent
of **all** parties to a communication.

The **Customer** is responsible for: (a) notifying its Authorized Users and any
other affected individuals that communications on the Service are recorded and
transcribed; (b) obtaining any consent required by the laws of the jurisdictions
in which it operates; and (c) using recordings and transcripts only for lawful
purposes. Authorized Users should assume that **all transmissions on the Service
are recorded**. Questions about a specific deployment should be directed to the
Customer organization.

## 7. Location information

Location reporting supports situational awareness and personnel safety (for
example, showing unit positions on the dispatch map and locating a unit during
an emergency). Where location reporting is used to monitor personnel, the
**Customer** is responsible for providing any notice required by applicable
employee-monitoring laws and for limiting tracking to lawful, work-related
purposes and times. Authorized Users may be able to disable location sharing
through device permissions; doing so may limit safety features.

## 8. Data retention

We retain information for as long as needed to provide the Service and as
instructed by the Customer, then delete or de-identify it. Unless the Customer's
agreement specifies otherwise, our default retention targets are:

- **Voice recordings and transcripts:** [RETENTION PERIOD — e.g., 90 days].
- **Location (last known position):** [RETENTION PERIOD].
- **Audit logs:** [RETENTION PERIOD].
- **Alerts:** [RETENTION PERIOD].
- **Account records:** for the term of the Customer's subscription, then
  deleted or de-identified within [PERIOD] after termination.

We may retain information longer where required by law, to resolve disputes, or
to enforce our agreements, or where the Customer places a legal hold.

> *Implementation note: automatic retention/purge is not yet implemented in the
> codebase (see `LEGAL_RISK_REVIEW.md`, Finding 7). Do not publish specific
> retention periods until the Service actually enforces them.*

## 9. Subprocessors and data location

We rely on the following categories of subprocessors to operate the Service:

| Subprocessor | Purpose | Location |
|--------------|---------|----------|
| [HOSTING / PaaS PROVIDER — e.g., Railway] | Application and database hosting | [REGION] |
| [DATABASE / STORAGE] | Stores accounts, recordings, transcripts, location, audit data | [REGION] |
| [MAP TILE PROVIDER] | Map tiles for the dispatch console | [REGION] |
| [OTHER] | [PURPOSE] | [REGION] |

Speech-to-text transcription is performed by a **self-hosted** model running
within our infrastructure; recordings are **not** sent to a third-party
transcription service for this purpose.

The Service is operated and data is stored in [COUNTRY / REGION]. A current list
of subprocessors is available at [URL / on request].

## 10. Security

We use administrative, technical, and physical safeguards designed to protect
information, including encryption in transit, hashed passwords, role-based
access controls, channel-scoped permissions, and audit logging. No method of
transmission or storage is completely secure, and we cannot guarantee absolute
security. If we become aware of a security incident affecting personal
information, we will notify affected Customers without undue delay and as
required by law and contract.

> *Implementation note: several access-control and configuration weaknesses
> identified in `LEGAL_RISK_REVIEW.md` (Findings 4 and 9) should be remediated
> before the statements in this section are published.*

## 11. Your privacy rights

Depending on where you live, you may have rights to access, correct, delete,
or obtain a copy of personal information about you, to opt out of certain
processing, and to be free from discrimination for exercising these rights.

Because most information in the Service is controlled by the **Customer** that
employs or engages you, **please direct privacy requests to your organization
first.** If you submit a request to us directly and we act as service provider,
we will forward it to the relevant Customer or assist the Customer in
responding. We will respond directly where we are the controller of the
information at issue.

To make a request, contact us at [PRIVACY CONTACT EMAIL]. We will verify your
request before responding and will not discriminate against you for exercising
your rights. You may use an authorized agent where the law permits.

## 12. California disclosures

For California residents, in the prior 12 months we have collected the
categories of personal information described in Section 3, which may include
**identifiers**, **internet/network activity**, **precise geolocation**,
**audio/electronic information** (recordings and transcripts), and
**professional/employment-related information**. We collect it for the purposes
in Section 4 and disclose it as described in Section 5.

We do **not sell** personal information and do **not share** it for
cross-context behavioral advertising. We use sensitive personal information
(such as precise geolocation) only for the purposes of providing the Service and
do not use it to infer characteristics about an individual. California residents
have the rights described in Section 11.

## 13. Children's privacy

The Service is intended for enterprise use by adults. We do not knowingly
collect personal information from anyone under 18.

## 14. Changes to this Policy

We may update this Policy from time to time. We will post the updated version
with a new "Last updated" date and, where required, notify Customers. Material
changes will be communicated as required by law or contract.

## 15. Contact us

[LEGAL ENTITY NAME]
[MAILING ADDRESS]
Privacy: [PRIVACY CONTACT EMAIL]
General: [GENERAL CONTACT EMAIL]
