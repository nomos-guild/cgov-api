// ─── Cardano Ecosystem Seed List ─────────────────────────────────────────────
//
// Curated list of known Cardano ecosystem GitHub organizations and repositories.
// Sources: adadev.io, ecosystem research, manual additions.
//
// These supplement the topic/keyword-based discovery in github-discovery.ts,
// catching ecosystem projects that don't tag themselves with "cardano" topics
// or include "cardano" in their name/description.
//
// To add a new org:   append to SEED_ORGS
// To add a single repo: append to SEED_REPOS (for orgs that aren't fully Cardano-focused)

// Organizations — all public repos in these orgs will be discovered
export const SEED_ORGS: string[] = [
  // ── Libraries & Languages ──────────────────────────────────────────────────
  "aiken-lang",           // Aiken smart contract language
  "OpShin",               // Python smart contracts
  "HeliosLang",           // Browser-based smart contract language
  "meshjs",               // MeshJS - JS/TS library for dApps
  "spacebudz",            // Lucid transaction library + NFTs
  "Python-Cardano",       // PyCardano
  "marlowe-lang",         // Marlowe smart contracts
  "CardanoSharp",         // .NET library
  "butaneprotocol",       // Blaze transaction library + synthetics
  "CardanoSolutions",     // Kupo indexer + Ogmios
  "scalus3",              // Scalus - Scala smart contracts
  "dQuadrant",            // Kuber transaction library
  "nomos-guild",          // CGOV governance tools
  "HarmonicLabs",         // plu-ts - TypeScript Cardano tooling
  "Anastasia-Labs",       // lucid-evolution + Aiken design patterns
  "Plutonomicon",         // cardano-transaction-lib (CTL)

  // ── Infrastructure & APIs ──────────────────────────────────────────────────
  "koios-official",       // Koios REST API
  "gimbalabs",            // Dandelion APIs + education
  "blockfrost",           // Blockfrost API
  "maestro-org",          // Maestro Web3 stack
  "dcSpark",              // Carp, Flint, Milkomeda
  "ODATANO",              // SAP-Cardano OData bridge
  "Andamio-Platform",     // Andamio protocol
  "vellum-labs",          // Cexplorer.io
  "cardanoapi",           // Cardano API tools
  "cardano-scaling",      // Hydra + Mithril layer 2
  "cardano-community",    // Guild Operators, CNTools, gRest
  "blinklabs-io",         // Blink Labs - Go Cardano tooling
  "mlabs-haskell",        // MLabs - Plutus tooling, Plutip, CLB
  "bloxbean",             // Yaci DevKit + Java Cardano lib
  "demeter-run",          // Cloud infra for Cardano dApps
  "StricaHQ",             // Strica - Typhon wallet, CardanoScan
  "fivebinaries",         // Five Binaries - Cardano infrastructure
  "vacuumlabs",           // Vacuum Labs - AdaLite wallet
  "tango-crypto",         // Tangocrypto API SaaS
  "berry-pool",           // Berry Pool - NFT Plutus contracts, CIP tools
  "koralabs",             // Kora Labs - $handle
  "Cardano-Forge",        // Cardano Forge
  "CardanoExplorer",      // AdaStat blockchain explorer
  "TxPipe",               // Oura, Pallas, Scrolls, Dolos

  // ── Wallets ─────────────────────────────────────────────────────────────────
  "Tastenkunst",          // Eternl wallet (formerly CCVault)
  "vespr-wallet",         // Vespr wallet
  "BeginWallet",          // Begin wallet
  "Gero-Labs",            // GeroWallet
  "nufi-official",        // NuFi multi-chain wallet
  "GameChangerFinance",   // GameChanger wallet

  // ── Minting & NFTs ────────────────────────────────────────────────────────
  "nftmakerio",           // NMKR
  "nftcdn",               // NFT CDN
  "FutureFest",           // NMKR Unity SDK
  "kreate-art",           // Kreate - Web3 art community

  // ── Security & Auditing ───────────────────────────────────────────────────
  "no-witness-labs",      // Smart contract audits

  // ── Founding Entities (supplement existing strategies) ─────────────────────
  "Emurgo",               // EMURGO

  // ── DeFi - DEXes ──────────────────────────────────────────────────────────
  "sundaeswap-finance",   // SundaeSwap DEX
  "WingRiders",           // WingRiders DEX
  "Minswap",              // Minswap DEX
  "SplashProtocol",       // Splash DEX
  "GeniusYield",          // Genius Yield optimizer
  "MuesliSwapTeam",       // MuesliSwap DEX
  "spectrum-finance",     // Spectrum Finance (formerly ErgoDEX)
  "vyfi",                 // VyFinance DEX + yield farming
  "teddy-swap",           // TeddySwap DEX
  "SaturnLabs",           // Saturn Swap order-book DEX
  "DexHunterIO",          // DexHunter DEX aggregator
  "JamOnBread",           // JamOnBread DEX

  // ── DeFi - Lending & Borrowing ────────────────────────────────────────────
  "Liqwid-Labs",          // Liqwid lending
  "lenfiLending",         // Lenfi lending
  "lenfiLabs",            // Lenfi (new org)
  "aadafinance",          // Aada Finance (legacy Lenfi)
  "FluidTokens",          // Fluid Tokens - NFT-collateralized loans
  "OptimFinance",         // Optim Finance - yield optimization
  "meld-labs",            // MELD - cross-chain lending
  "flow-lending",         // Flow lending protocol
  "levvio",               // Levvi DEX aggregator
  "Levvy-fi",             // Levvy NFT lending

  // ── DeFi - Stablecoins & Synthetics ───────────────────────────────────────
  "IndigoProtocol",       // Indigo Protocol - synthetic assets
  "DjedAlliance",         // Djed stablecoin alliance
  "ArdanaLabs",           // Ardana stablecoin (inactive)

  // ── DeFi - Other ──────────────────────────────────────────────────────────
  "jpg-store",            // JPG Store NFT marketplace
  "anetaBTC",             // anetaBTC - Bitcoin bridge
  "encryptedcoins",       // ENCOINS - privacy protocol

  // ── Oracles ───────────────────────────────────────────────────────────────
  "Charli3-Official",     // Charli3 oracle
  "orcfax",               // Orcfax decentralized oracle

  // ── Identity ──────────────────────────────────────────────────────────────
  "IAMXID",               // IAMX self-sovereign identity

  // ── Analytics ─────────────────────────────────────────────────────────────
  "TheTapHouse",          // TapTools portfolio analytics
  "XerberusTeam",         // Xerberus risk ratings
  "SmaugPool",            // Pool.pm visualization
  "pool-pm",              // Pool.pm minting data

  // ── AI & Blockchain ───────────────────────────────────────────────────────
  "masumi-network",       // Masumi AI agent platform
  "singularitynet",       // SingularityNET
  "SingularityNET-Archive", // SingularityNET public repos
  "nunet-official",       // NuNet distributed compute
  "iagon-tech",           // Iagon decentralized storage
  "goat-sdk",             // GOAT SDK AI agents

  // ── Gaming & Content ──────────────────────────────────────────────────────
  "PaimaStudios",         // Paima - trustless Web3 gaming engine
  "Cornucopias",          // Cornucopias MMO game
  "projectNEWM",          // NEWM music platform
  "book-io",              // Book.io digital books

  // ── Telecom & Real World ──────────────────────────────────────────────────
  "worldmobilegroup",     // World Mobile telecom

  // ── Sidechains & Bridges ──────────────────────────────────────────────────
  "midnight-ntwrk",       // Midnight privacy sidechain

  // ── DAO & Governance ──────────────────────────────────────────────────────
  "ADAOcommunity",        // ADAO - RoundTable multisig, Agora governance
  "DripDropz",            // DripDropz token distribution + voting
  "FreeLoaderz",          // FreeLoaderz SPO coalition

  // ── Events & Community ────────────────────────────────────────────────────
  "RareEvo",              // Rare Evo / Rare Network
  "danogo-finance",       // Danogo bond DEX
];

// Individual repos — listed individually when only specific repos from an org are relevant
export const SEED_REPOS: string[] = [
  "Odiobill/NmkrGodot",          // NMKR Godot plugin
  "CharlesHoskinson/jolt-tla",    // Jolt zkVM TLA+ spec
];
