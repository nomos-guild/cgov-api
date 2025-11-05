import { Request, Response } from "express";
import { getBlockfrostService } from "../../services";

/**
 * Get governance action proposals from Blockfrost API.
 *
 * Default behavior: Fetches ALL proposals across all pages automatically.
 * Single page mode: Specify the 'page' parameter to fetch only that specific page.
 *
 * @param req - Express request with query params: count, page, order
 * @param res - Express response
 *
 * Blockfrost API Reference:
 * https://docs.blockfrost.io/#tag/cardano--governance/get/governance/proposals
 */
export const getProposals = async (req: Request, res: Response) => {
  try {
    const blockfrost = getBlockfrostService();

    // Parse pagination parameters
    const count = Math.min(
      parseInt(req.query.count as string) || 100,
      100
    );
    const order = (req.query.order as string) === "desc" ? "desc" : "asc";

    // If page is specified, return only that page
    if (req.query.page) {
      const page = Math.max(parseInt(req.query.page as string), 1);
      const response = await blockfrost.get("/governance/proposals", {
        params: { count, page, order },
      });
      return res.json(response.data);
    }

    // Default: Fetch all pages until no more records
    const allProposals: any[] = [];
    let currentPage = 1;
    let hasMoreData = true;

    while (hasMoreData) {
      const response = await blockfrost.get("/governance/proposals", {
        params: {
          count,
          page: currentPage,
          order,
        },
      });

      const data = response.data;

      if (Array.isArray(data) && data.length > 0) {
        allProposals.push(...data);
        // If we got less than the requested count, we've reached the end
        hasMoreData = data.length === count;
        currentPage++;
      } else {
        hasMoreData = false;
      }
    }

    res.json(allProposals);
  } catch (error) {
    console.error("Error fetching proposals:", error);
    res.status(500).json({
      error: "Failed to fetch governance proposals",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
