import { Request, Response } from "express";
import { formatAxiosLikeError } from "../../utils/format-http-client-error";

/**
 * POST /data/ipfs/upload
 *
 * Accepts a JSON object in the request body and uploads it to IPFS
 * via Blockfrost's IPFS API. Returns the CID and a public gateway URL.
 *
 * Request body: { json: object }
 * Response: { success: true, cid: string, url: string }
 */
export const postUploadToIpfs = async (req: Request, res: Response) => {
  try {
    const { json } = req.body;

    if (!json || typeof json !== "object") {
      return res.status(400).json({
        error: "Missing or invalid 'json' field in request body",
      });
    }

    const projectId = process.env.IPFS_BLOCKFROST_API_KEY;

    if (!projectId) {
      return res.status(500).json({
        error: "IPFS upload not configured",
      });
    }

    const blob = new Blob([JSON.stringify(json)], {
      type: "application/json",
    });
    const formData = new FormData();
    formData.append("file", blob, "metadata.jsonld");

    // Upload to Blockfrost IPFS
    const addResponse = await fetch(
      "https://ipfs.blockfrost.io/api/v0/ipfs/add",
      {
        method: "POST",
        headers: { project_id: projectId },
        body: formData,
      }
    );

    if (!addResponse.ok) {
      const errorBody = await addResponse.text();
      throw new Error(
        `Blockfrost IPFS add failed (${addResponse.status}): ${errorBody}`
      );
    }

    const addData = (await addResponse.json()) as { ipfs_hash: string };
    const cid = addData.ipfs_hash;

    // Pin the uploaded content so it's not garbage collected
    const pinResponse = await fetch(
      `https://ipfs.blockfrost.io/api/v0/ipfs/pin/add/${cid}`,
      {
        method: "POST",
        headers: { project_id: projectId },
      }
    );

    if (!pinResponse.ok) {
      const errorBody = await pinResponse.text();
      throw new Error(
        `Blockfrost IPFS pin failed (${pinResponse.status}): ${errorBody}`
      );
    }

    console.log(`[IPFS Upload] ✓ Uploaded and pinned to IPFS: ${cid}`);

    res.json({
      success: true,
      cid,
      url: `https://ipfs.io/ipfs/${cid}`,
    });
  } catch (error) {
    console.error("[IPFS Upload] Error:", formatAxiosLikeError(error));

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    res.status(500).json({
      error: "Failed to upload to IPFS",
      message: errorMessage,
    });
  }
};
