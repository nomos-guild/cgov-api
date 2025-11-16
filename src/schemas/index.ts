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
