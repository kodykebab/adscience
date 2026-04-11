// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {FHE, euint8, euint64, InEuint64, ebool} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract EAX is Ownable {
    struct Advertiser {
        uint64[5] vector;
        uint64 bid;
        address addr;
        bool active;
    }

    Advertiser[10] public advertisers; // Increased to 10 for dynamic registration
    uint256 public nextAdvertiserId;

    IERC20 public token;

    struct MatchTask {
        euint8 winnerIndex;
        euint64 payout;
        address user;
        bool exists;
        bool finalized;
    }

    uint256 public taskCount;
    mapping(uint256 => MatchTask) public tasks;

    euint64 private EUINT64_ZERO;
    euint8 private EUINT8_ZERO;

    event AdvertisersInitialized();
    event MatchSubmitted(uint256 indexed taskId, address indexed user);
    event PayoutClaimed(uint256 indexed taskId, address indexed user, uint64 amount, uint8 winnerIndex);

    constructor(address _token) Ownable(msg.sender) {
        token = IERC20(_token);
        EUINT64_ZERO = FHE.asEuint64(0);
        EUINT8_ZERO = FHE.asEuint8(0);
    }

    // Hardcoded for demo explicitly as requested
    function initializeAdvertisers() external onlyOwner {
        require(nextAdvertiserId == 0, "Already initialized");
        advertisers[0] = Advertiser([uint64(1), 0, 1, 0, 0], 10, msg.sender, true);
        advertisers[1] = Advertiser([uint64(0), 1, 1, 0, 1], 15, msg.sender, true);
        advertisers[2] = Advertiser([uint64(1), 1, 0, 1, 0], 12, msg.sender, true);
        nextAdvertiserId = 3;
        
        emit AdvertisersInitialized();
    }

    event AdvertiserRegistered(uint256 indexed id, address indexed addr, uint64 bid);

    function registerAdvertiser(uint64[5] calldata _vector, uint64 _bid) external {
        require(nextAdvertiserId < 10, "Max advertisers reached");
        uint256 id = nextAdvertiserId++;
        advertisers[id] = Advertiser(_vector, _bid, msg.sender, true);
        emit AdvertiserRegistered(id, msg.sender, _bid);
    }

    // Submit an encrypted vector of interests
    function matchIntent(InEuint64[] calldata _encVec) external returns (uint256) {
        require(_encVec.length == 5, "Vector must be size 5");
        
        euint64[5] memory userVector;
        for (uint i = 0; i < 5; i++) {
            userVector[i] = FHE.asEuint64(_encVec[i]);
            // Allow this contract to use the variable
            FHE.allowThis(userVector[i]);
        }

        euint64 maxPayout = EUINT64_ZERO;
        euint8 winnerIndex = EUINT8_ZERO;

        for (uint8 a = 0; a < nextAdvertiserId; a++) {
            if (!advertisers[a].active) continue;

            euint64 score = EUINT64_ZERO;
            
            // Calculate dot product
            for (uint i = 0; i < 5; i++) {
                if (advertisers[a].vector[i] == 1) {
                    score = FHE.add(score, userVector[i]);
                }
            }

            // Calculate value (score * bid)
            // we first convert the plaintext bid to euint64
            euint64 bidValue = FHE.mul(score, FHE.asEuint64(advertisers[a].bid));
            
            ebool isHigher = FHE.gt(bidValue, maxPayout);

            // Update max value and winner index
            maxPayout = FHE.select(isHigher, bidValue, maxPayout);
            winnerIndex = FHE.select(isHigher, FHE.asEuint8(a), winnerIndex);
        }

        uint256 taskId = taskCount++;
        MatchTask storage task = tasks[taskId];
        task.winnerIndex = winnerIndex;
        task.payout = maxPayout;
        task.user = msg.sender;
        task.exists = true;
        task.finalized = false;

        // Allow public to decrypt the exact winner and payout amount over Fhenix threshold network
        // Needed so a relayer/the user can bring it back for the token payout
        FHE.allowPublic(task.winnerIndex);
        FHE.allowPublic(task.payout);

        // Required to keep track of this inside the contract (add the allowances so we can verify if we need to locally)
        FHE.allowThis(task.winnerIndex);
        FHE.allowThis(task.payout);

        emit MatchSubmitted(taskId, msg.sender);
        return taskId;
    }

    function revealAndClaim(
        uint256 _taskId, 
        uint8 _winnerIndex, 
        bytes calldata _winnerSig, 
        uint64 _payout, 
        bytes calldata _payoutSig
    ) external {
        MatchTask storage task = tasks[_taskId];
        require(task.exists, "Task not found");
        require(!task.finalized, "Already claimed");
        require(msg.sender == task.user, "Not your task");

        // Verify decryption result using CoFHE mechanism
        FHE.publishDecryptResult(task.winnerIndex, _winnerIndex, _winnerSig);
        FHE.publishDecryptResult(task.payout, _payout, _payoutSig);

        task.finalized = true;

        if (_payout > 0) {
            token.transfer(task.user, uint256(_payout) * (10 ** 18));
        }

        emit PayoutClaimed(_taskId, msg.sender, _payout, _winnerIndex);
    }
}
