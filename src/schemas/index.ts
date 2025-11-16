/**
 * @openapi
 * components:
 *   schemas:
 *     Proposal:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Governance action ID
 *           example: gov_action1zhuz5djmmmjg8f9s8pe6grfc98xg3szglums8cgm6qwancp4eytqqmpu0pr
 *         tx_hash:
 *           type: string
 *           description: Transaction hash
 *           example: 15f82a365bdee483a4b03873a40d3829cc88c048ff3703e11bd01dd9e035c916
 *         cert_index:
 *           type: integer
 *           description: Certificate index
 *           example: 0
 *         governance_type:
 *           type: string
 *           description: Type of governance action
 *           example: info_action
 *     SignInRequest:
 *       type: object
 *       required:
 *         - walletAddress
 *       properties:
 *         walletAddress:
 *           type: string
 *           description: Cardano wallet address
 *           example: addr1qxy3w6z5...
 *     SignInResponse:
 *       type: object
 *       properties: {}
 *     GetNCLDataResponse:
 *       type: object
 *       properties:
 *         year:
 *           type: string
 *           description: Year of the NCL data
 *           example: "2024"
 *         currentValue:
 *           type: string
 *           description: Current NCL value
 *           example: "1234.56"
 *         targetValue:
 *           type: string
 *           description: Target NCL value
 *           example: "5000.00"
 *     GetProposalListReponse:
 *       type: array
 *       items:
 *         type: object
 *         properties:
 *           proposalId:
 *             type: string
 *             description: Unique identifier for the proposal
 *             example: "prop_123456"
 *           txHash:
 *             type: string
 *             description: Transaction hash
 *             example: "15f82a365bdee483a4b03873a40d3829cc88c048ff3703e11bd01dd9e035c916"
 *           title:
 *             type: string
 *             description: Proposal title
 *             example: "Infrastructure Improvement Proposal"
 *           type:
 *             type: string
 *             description: Type of proposal
 *             example: "Treasury"
 *           status:
 *             type: string
 *             enum: [Active, Ratified, Expired, Approved, Not approved]
 *             description: Current status of the proposal
 *             example: "Active"
 *           constitutionality:
 *             type: string
 *             description: Constitutionality status
 *             example: "Constitutional"
 *           totalYes:
 *             type: number
 *             description: Total yes votes
 *             example: 1500
 *           totalNo:
 *             type: number
 *             description: Total no votes
 *             example: 300
 *           totalAbstain:
 *             type: number
 *             description: Total abstain votes
 *             example: 200
 *           submissionEpoch:
 *             type: number
 *             description: Epoch when submitted
 *             example: 450
 *           expiryEpoch:
 *             type: number
 *             description: Epoch when expires
 *             example: 500
 *     GetProposalInfoResponse:
 *       type: object
 *       properties:
 *         proposalId:
 *           type: string
 *           description: Unique identifier for the proposal
 *           example: "prop_123456"
 *         txHash:
 *           type: string
 *           description: Transaction hash
 *           example: "15f82a365bdee483a4b03873a40d3829cc88c048ff3703e11bd01dd9e035c916"
 *         title:
 *           type: string
 *           description: Proposal title
 *           example: "Infrastructure Improvement Proposal"
 *         type:
 *           type: string
 *           description: Type of proposal
 *           example: "Treasury"
 *         status:
 *           type: string
 *           enum: [Active, Ratified, Expired, Approved, Not approved]
 *           description: Current status of the proposal
 *           example: "Active"
 *         constitutionality:
 *           type: string
 *           description: Constitutionality status
 *           example: "Constitutional"
 *         description:
 *           type: string
 *           description: Detailed description of the proposal
 *           example: "This proposal aims to improve the network infrastructure..."
 *         rationale:
 *           type: string
 *           description: Rationale behind the proposal
 *           example: "Current infrastructure requires upgrades to handle increased load..."
 *         totalYes:
 *           type: number
 *           description: Total yes votes
 *           example: 1500
 *         totalNo:
 *           type: number
 *           description: Total no votes
 *           example: 300
 *         totalAbstain:
 *           type: number
 *           description: Total abstain votes
 *           example: 200
 *         submissionEpoch:
 *           type: number
 *           description: Epoch when submitted
 *           example: 450
 *         expiryEpoch:
 *           type: number
 *           description: Epoch when expires
 *           example: 500
 *         votes:
 *           type: array
 *           description: List of individual votes
 *           items:
 *             type: object
 *             properties:
 *               voterType:
 *                 type: string
 *                 enum: [DRep, SPO, CC]
 *                 description: Type of voter
 *                 example: "DRep"
 *               voterId:
 *                 type: string
 *                 description: Voter identifier
 *                 example: "drep_123"
 *               voterName:
 *                 type: string
 *                 description: Voter name
 *                 example: "John Doe"
 *               vote:
 *                 type: string
 *                 enum: [Yes, No, Abstain]
 *                 description: Vote choice
 *                 example: "Yes"
 *               votingPower:
 *                 type: string
 *                 description: Voting power
 *                 example: "1000000"
 *               votingPowerAda:
 *                 type: number
 *                 description: Voting power in ADA
 *                 example: 1000000
 *               anchorUrl:
 *                 type: string
 *                 description: Anchor URL for vote metadata
 *                 example: "https://example.com/vote-metadata"
 *               anchorHash:
 *                 type: string
 *                 description: Hash of the anchor
 *                 example: "abc123def456"
 *               votedAt:
 *                 type: string
 *                 description: Timestamp when vote was cast
 *                 example: "2024-01-15T10:30:00Z"
 *         ccVotes:
 *           type: array
 *           description: Constitutional Committee votes
 *           items:
 *             type: object
 *             properties:
 *               voterType:
 *                 type: string
 *                 enum: [DRep, SPO, CC]
 *                 description: Type of voter
 *                 example: "CC"
 *               voterId:
 *                 type: string
 *                 description: Voter identifier
 *                 example: "cc_123"
 *               voterName:
 *                 type: string
 *                 description: Voter name
 *                 example: "Jane Smith"
 *               vote:
 *                 type: string
 *                 enum: [Yes, No, Abstain]
 *                 description: Vote choice
 *                 example: "Yes"
 *               votingPower:
 *                 type: string
 *                 description: Voting power
 *                 example: "1"
 *               votingPowerAda:
 *                 type: number
 *                 description: Voting power in ADA
 *                 example: 1
 *               anchorUrl:
 *                 type: string
 *                 description: Anchor URL for vote metadata
 *                 example: "https://example.com/cc-vote-metadata"
 *               anchorHash:
 *                 type: string
 *                 description: Hash of the anchor
 *                 example: "xyz789ghi012"
 *               votedAt:
 *                 type: string
 *                 description: Timestamp when vote was cast
 *                 example: "2024-01-15T11:00:00Z"
 *     ErrorResponse:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 *         message:
 *           type: string
 *           description: Detailed error description
 */
