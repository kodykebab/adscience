// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {FHE, euint8, euint64, InEuint64, ebool} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract EAX is Ownable {

    // ── Structs ──────────────────────────────────────────────────────

    struct Advertiser {
        uint64[5] vector;   // Weighted targeting vector (0–100 per category)
        uint64 bid;         // Max bid in ATTN tokens
        address addr;
        bool active;
    }

    struct MatchTask {
        euint8 winnerIndex;
        euint64 winnerScore;    // Raw encrypted dot-product score
        address user;
        bool exists;
        bool revealed;
    }

    // ── Storage ──────────────────────────────────────────────────────

    Advertiser[10] public advertisers;
    uint256 public nextAdvertiserId;

    IERC20 public token;

    // Lazy FHE initialization — avoids expensive coprocessor calls in constructor
    bool private _fheInitialized;
    euint64 private EUINT64_ZERO;
    euint8  private EUINT8_ZERO;

    uint256 public taskCount;
    mapping(uint256 => MatchTask) public tasks;

    // Cross-site ad serving state
    mapping(address => uint8)   public activeAdvertiser;   // user → winning advertiser ID
    mapping(address => bool)    public hasActiveMatch;      // user has a pending ad to view
    mapping(address => uint256) public lastMatchTask;       // taskId for reference
    mapping(address => uint64)  public matchScore;          // decrypted dot-product score
    mapping(address => uint64)  public matchMaxScore;       // max possible score (for normalization)

    // ── Events ───────────────────────────────────────────────────────

    event AdvertiserRegistered(uint256 indexed id, address indexed addr, uint64 bid);
    event MatchSubmitted(uint256 indexed taskId, address indexed user);
    event MatchRevealed(address indexed user, uint8 advertiserId, uint64 score, uint64 maxScore);
    event ImpressionRecorded(address indexed user, uint8 advertiserId, uint256 payoutWei);

    // ── Constructor ──────────────────────────────────────────────────
    // No FHE calls here — prevents deployment timeout on Sepolia CoFHE

    constructor(address _token) Ownable(msg.sender) {
        token = IERC20(_token);
    }

    // ── Internal: Lazy FHE Init ──────────────────────────────────────
    // First call to matchIntent() initializes the encrypted zero constants.
    // This avoids the expensive CoFHE coprocessor calls during contract deployment.

    function _ensureFHEInit() internal {
        if (!_fheInitialized) {
            EUINT64_ZERO = FHE.asEuint64(0);
            EUINT8_ZERO  = FHE.asEuint8(0);
            _fheInitialized = true;
        }
    }

    // ── Advertiser Management ────────────────────────────────────────

    function registerAdvertiser(uint64[5] calldata _vector, uint64 _bid) external {
        require(nextAdvertiserId < 10, "Max advertisers reached");

        bool hasWeight = false;
        for (uint i = 0; i < 5; i++) {
            require(_vector[i] <= 100, "Weight must be 0-100");
            if (_vector[i] > 0) hasWeight = true;
        }
        require(hasWeight, "At least one category weight required");
        require(_bid > 0, "Bid must be > 0");

        uint256 id = nextAdvertiserId++;
        advertisers[id] = Advertiser(_vector, _bid, msg.sender, true);
        emit AdvertiserRegistered(id, msg.sender, _bid);
    }

    /// @notice Explicit getter — Solidity auto-getters skip fixed arrays in structs
    function getAdvertiser(uint256 _id) external view returns (
        uint64[5] memory vector,
        uint64 bid,
        address addr,
        bool active
    ) {
        Advertiser storage adv = advertisers[_id];
        return (adv.vector, adv.bid, adv.addr, adv.active);
    }

    // ── Phase 1: Encrypted Matching ──────────────────────────────────
    // User submits encrypted interest vector (weighted 0–100 per category).
    // Contract computes FHE weighted dot products against all advertisers
    // and selects the winner (highest score × bid).
    // Both winnerIndex and raw winnerScore are stored encrypted for later decryption.

    function matchIntent(InEuint64[] calldata _encVec) external returns (uint256) {
        require(_encVec.length == 5, "Vector must be size 5");
        _ensureFHEInit();

        euint64[5] memory userVector;
        for (uint i = 0; i < 5; i++) {
            userVector[i] = FHE.asEuint64(_encVec[i]);
            FHE.allowThis(userVector[i]);
        }

        euint64 maxValue      = EUINT64_ZERO;   // Best (score × bid) — auction ranking
        euint8  winnerIndex    = EUINT8_ZERO;    // Index of winning advertiser
        euint64 winnerRawScore = EUINT64_ZERO;   // Raw dot product of winner (for reward scaling)
        bool firstCandidate = true;

        for (uint8 a = 0; a < nextAdvertiserId; a++) {
            if (!advertisers[a].active) continue;

            euint64 score = EUINT64_ZERO;

            // Weighted dot product: sum(user[i] × adv[i]) for non-zero weights
            for (uint i = 0; i < 5; i++) {
                if (advertisers[a].vector[i] > 0) {
                    euint64 weight   = FHE.asEuint64(advertisers[a].vector[i]);
                    euint64 weighted = FHE.mul(userVector[i], weight);
                    score = FHE.add(score, weighted);
                }
            }

            // Auction value = score × bid (higher score+bid combo wins)
            euint64 bidValue = FHE.mul(score, FHE.asEuint64(advertisers[a].bid));

            if (firstCandidate) {
                // First active advertiser becomes the baseline — avoids gt(x, 0) edge case
                maxValue       = bidValue;
                winnerIndex    = FHE.asEuint8(a);
                winnerRawScore = score;
                firstCandidate = false;
            } else {
                ebool isHigher = FHE.gt(bidValue, maxValue);
                maxValue       = FHE.select(isHigher, bidValue, maxValue);
                winnerIndex    = FHE.select(isHigher, FHE.asEuint8(a), winnerIndex);
                winnerRawScore = FHE.select(isHigher, score, winnerRawScore);
            }
        }

        uint256 taskId = taskCount++;
        MatchTask storage task = tasks[taskId];
        task.winnerIndex = winnerIndex;
        task.winnerScore = winnerRawScore;
        task.user    = msg.sender;
        task.exists   = true;
        task.revealed = false;

        // Allow threshold network to decrypt both values
        FHE.allowPublic(task.winnerIndex);
        FHE.allowThis(task.winnerIndex);
        FHE.allowPublic(task.winnerScore);
        FHE.allowThis(task.winnerScore);

        emit MatchSubmitted(taskId, msg.sender);
        return taskId;
    }

    // ── Phase 2: Reveal Match ────────────────────────────────────────
    // User brings decrypted winnerIndex + winnerScore with threshold signatures.
    // Contract verifies via CoFHE publishDecryptResult, then pre-computes the
    // score-proportional reward stored for later payout.

    function revealMatch(
        uint256 _taskId,
        uint8   _winnerIndex,
        bytes calldata _winnerSig,
        uint64  _winnerScore,
        bytes calldata _scoreSig
    ) external {
        MatchTask storage task = tasks[_taskId];
        require(task.exists,       "Task not found");
        require(!task.revealed,    "Already revealed");
        require(msg.sender == task.user, "Not your task");

        // Verify both threshold decryption results on-chain
        FHE.publishDecryptResult(task.winnerIndex, _winnerIndex, _winnerSig);
        FHE.publishDecryptResult(task.winnerScore, _winnerScore, _scoreSig);

        task.revealed = true;

        // Max possible score for this advertiser: sum(advVector[i] × 100)
        // i.e., if user had perfect 100 interest in every targeted category
        uint64 maxPossible = 0;
        for (uint i = 0; i < 5; i++) {
            maxPossible += advertisers[_winnerIndex].vector[i] * 100;
        }

        // Store match data for cross-site ad serving + payout computation
        activeAdvertiser[msg.sender] = _winnerIndex;
        hasActiveMatch[msg.sender]   = true;
        lastMatchTask[msg.sender]    = _taskId;
        matchScore[msg.sender]       = _winnerScore;
        matchMaxScore[msg.sender]    = maxPossible;

        emit MatchRevealed(msg.sender, _winnerIndex, _winnerScore, maxPossible);
    }

    // ── Phase 3: Record Impression ───────────────────────────────────
    // Called by the SDK on ANY website when the winning ad is displayed.
    //
    // Payout formula (score-proportional):
    //   payoutWei = bid × (matchScore / maxScore) × 10^18
    //
    // A perfect match (100% quality) pays the full bid.
    // Partial matches pay proportionally — better relevance = higher reward.

    function recordImpression() external {
        require(hasActiveMatch[msg.sender], "No active match");

        uint8 advId = activeAdvertiser[msg.sender];
        require(advertisers[advId].active, "Advertiser inactive");

        uint256 score    = uint256(matchScore[msg.sender]);
        uint256 maxScore = uint256(matchMaxScore[msg.sender]);
        uint256 bid      = uint256(advertisers[advId].bid);

        // Reset state — one payout per match
        hasActiveMatch[msg.sender]   = false;
        activeAdvertiser[msg.sender] = 0;
        matchScore[msg.sender]       = 0;
        matchMaxScore[msg.sender]    = 0;

        // Score-proportional payout: bid × (score / maxScore)
        // Computed as (bid × score × 1e18) / maxScore to preserve full token-decimal precision
        uint256 payoutWei = 0;
        if (maxScore > 0 && score > 0) {
            payoutWei = (bid * score * 1e18) / maxScore;
        }

        if (payoutWei > 0) {
            token.transfer(msg.sender, payoutWei);
        }

        emit ImpressionRecorded(msg.sender, advId, payoutWei);
    }
}
