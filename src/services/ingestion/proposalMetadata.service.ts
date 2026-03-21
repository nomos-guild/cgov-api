import { fetchTxMetadataByHash } from "../txMetadata.service";
import { fetchJsonWithBrowserLikeClient } from "../remoteMetadata.service";
import { withRetry } from "./utils";
import {
  extractSurveyDetails,
  type SurveyDetails,
} from "../../libs/surveyMetadata";
import type { KoiosProposal } from "../../types/koios.types";

export interface ExtractProposalMetadataOptions {
  preferMetaUrlForMissingFields?: boolean;
  retryMetaUrlFetch?: boolean;
}

export async function extractProposalMetadata(
  proposal: KoiosProposal,
  options?: ExtractProposalMetadataOptions
): Promise<{
  title: string;
  description: string | null;
  rationale: string | null;
  metadata: string | null;
}> {
  const preferMetaUrlForMissingFields =
    options?.preferMetaUrlForMissingFields ?? false;
  const retryMetaUrlFetch = options?.retryMetaUrlFetch ?? false;

  if (proposal.meta_json?.body) {
    const body = proposal.meta_json.body;
    const fromBody = {
      title: sanitizeText(body.title) || "Untitled Proposal",
      description: sanitizeText(body.abstract),
      rationale: sanitizeText(body.rationale),
      metadata: JSON.stringify(proposal.meta_json),
    };

    if (
      preferMetaUrlForMissingFields &&
      hasMissingExtractedMetadataFields(fromBody) &&
      proposal.meta_url
    ) {
      const fromUrl = await fetchMetadataFromUrl(
        proposal.meta_url,
        retryMetaUrlFetch
      );
      if (fromUrl) {
        return {
          title:
            isMeaningfulTitle(fromBody.title) && !isMissingText(fromBody.title)
              ? fromBody.title
              : fromUrl.title,
          description:
            !isMissingText(fromBody.description)
              ? fromBody.description
              : fromUrl.description,
          rationale:
            !isMissingText(fromBody.rationale)
              ? fromBody.rationale
              : fromUrl.rationale,
          metadata: fromUrl.metadata ?? fromBody.metadata,
        };
      }
    }

    return fromBody;
  }

  if (proposal.meta_url) {
    const fromUrl = await fetchMetadataFromUrl(
      proposal.meta_url,
      retryMetaUrlFetch
    );
    if (fromUrl) {
      return fromUrl;
    }
  }

  return {
    title: "Untitled Proposal",
    description: null,
    rationale: null,
    metadata: null,
  };
}

async function fetchMetadataFromUrl(
  metaUrl: string,
  retryMetaUrlFetch: boolean
): Promise<{
  title: string;
  description: string | null;
  rationale: string | null;
  metadata: string | null;
} | null> {
  try {
    const fetchOnce = async () => {
      const metaData = await fetchJsonWithBrowserLikeClient(metaUrl);
      if (!metaData) {
        throw new Error("Metadata endpoint returned no JSON payload");
      }
      return {
        title: sanitizeText(metaData?.body?.title) || "Untitled Proposal",
        description: sanitizeText(metaData?.body?.abstract),
        rationale: sanitizeText(metaData?.body?.rationale),
        metadata: JSON.stringify(metaData),
      };
    };

    if (!retryMetaUrlFetch) {
      return fetchOnce();
    }

    return withRetry(fetchOnce, {
      maxRetries: 1,
      baseDelay: 1000,
      maxDelay: 2000,
    });
  } catch (error: any) {
    const status = error.response?.status;
    const errorMsg =
      status === 404
        ? `Metadata URL not found (404): ${metaUrl}`
        : `Failed to fetch metadata from ${metaUrl}`;

    console.warn(`[Metadata] ${errorMsg}`);
    return null;
  }
}

export async function fetchLinkedSurveyDetails(
  surveyTxId: string
): Promise<SurveyDetails | null> {
  const metadata = await fetchTxMetadataByHash(surveyTxId);
  if (!metadata) {
    return null;
  }

  return extractSurveyDetails(metadata);
}

function sanitizeText(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value;
}

function isMissingText(value: string | null | undefined): boolean {
  return value == null || value.trim() === "";
}

function isMeaningfulTitle(value: string | null | undefined): boolean {
  return !isMissingText(value) && value !== "Untitled Proposal";
}

function hasMissingExtractedMetadataFields(fields: {
  title: string;
  description: string | null;
  rationale: string | null;
}): boolean {
  return (
    !isMeaningfulTitle(fields.title) ||
    isMissingText(fields.description) ||
    isMissingText(fields.rationale)
  );
}

export function hasMissingProposalInfoFields(fields: {
  title: string;
  description: string | null;
  rationale: string | null;
}): boolean {
  return (
    !isMeaningfulTitle(fields.title) ||
    isMissingText(fields.description) ||
    isMissingText(fields.rationale)
  );
}
