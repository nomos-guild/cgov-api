import express from "express";
import { placeholderGet } from "../controllers";

const router = express.Router();

/**
 * @openapi
 * /overview:
 *   get:
 *     summary: Get NCL data overview
 *     description: Retrieves NCL (Net Carbon Liability) data including year, current value, and target value
 *     tags:
 *       - Overview
 *     responses:
 *       200:
 *         description: Successfully retrieved NCL data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetNCLDataResponse'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/", placeholderGet);

export default router;
