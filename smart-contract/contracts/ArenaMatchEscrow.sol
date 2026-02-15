// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

contract ArenaMatchEscrow {
    address public owner;

    enum MatchStatus {
        CREATED,
        ACTIVE,
        RESOLVED
    }

    struct Match {
        address player1;
        address player2;
        uint256 betAmount;
        bool player1Paid;
        bool player2Paid;
        MatchStatus status;
        address winner;
    }

    uint256 public matchCount;
    mapping(uint256 => Match) public matches;

    // ---------------- EVENTS ----------------
    event MatchCreated(uint256 indexed matchId, address player1, address player2, uint256 betAmount);
    event PlayerJoined(uint256 indexed matchId, address player);
    event MatchActivated(uint256 indexed matchId);
    event MatchResolved(uint256 indexed matchId, address winner, uint256 payout);

    // ---------------- MODIFIERS ----------------
    modifier onlyOwner() {
        require(msg.sender == owner, "Not server");
        _;
    }

    modifier onlyPlayer(uint256 matchId) {
        Match memory m = matches[matchId];
        require(
            msg.sender == m.player1 || msg.sender == m.player2,
            "Not a player"
        );
        _;
    }

    constructor() {
        owner = msg.sender; // server wallet
    }

    // ---------------- SERVER ACTION ----------------

    /// @notice Server creates match with 2 players
    function createMatch(
        address _player1,
        address _player2,
        uint256 _betAmount
    ) external onlyOwner returns (uint256) {

        uint256 newMatchId = matchCount;

        matches[newMatchId] = Match({
            player1: _player1,
            player2: _player2,
            betAmount: _betAmount,
            player1Paid: false,
            player2Paid: false,
            status: MatchStatus.CREATED,
            winner: address(0)
        });

        matchCount++;

        emit MatchCreated(newMatchId, _player1, _player2, _betAmount);

        return newMatchId;
    }

    // ---------------- PLAYER ACTION ----------------

    function cancelMatch(uint256 matchId) external onlyOwner {
    require(matchId < matchCount, "Invalid match");

    Match storage m = matches[matchId];

    require(m.status == MatchStatus.CREATED, "Cannot cancel");

    // เก็บข้อมูลก่อนแก้ state
    address p1 = m.player1;
    address p2 = m.player2;
    uint256 bet = m.betAmount;

    bool p1Paid = m.player1Paid;
    bool p2Paid = m.player2Paid;

    // ---- EFFECTS (เปลี่ยน state ก่อนโอนเงิน) ----
    m.status = MatchStatus.RESOLVED;
    m.winner = address(0);
    m.player1Paid = false;
    m.player2Paid = false;

    // ---- INTERACTIONS (refund) ----
    if (p1Paid) {
        (bool s1, ) = p1.call{value: bet}("");
        require(s1, "Refund p1 failed");
    }

    if (p2Paid) {
        (bool s2, ) = p2.call{value: bet}("");
        require(s2, "Refund p2 failed");
    }
}
    /// @notice Player sends escrow to join the match
    function joinMatch(uint256 matchId) external payable onlyPlayer(matchId) {
        Match storage m = matches[matchId];

        require(m.status == MatchStatus.CREATED, "Match not joinable");
        require(msg.value == m.betAmount, "Incorrect bet amount");

        if (msg.sender == m.player1) {
            require(!m.player1Paid, "Player1 already paid");
            m.player1Paid = true;
        } else {
            require(!m.player2Paid, "Player2 already paid");
            m.player2Paid = true;
        }

        emit PlayerJoined(matchId, msg.sender);

        // Both players paid → match becomes active
        if (m.player1Paid && m.player2Paid) {
            m.status = MatchStatus.ACTIVE;
            emit MatchActivated(matchId);
        }
    }

    // ---------------- SERVER RESOLVE ----------------

    /// @notice Server decides winner and releases escrow
    function resolveMatch(uint256 matchId, address _winner) external onlyOwner {
        Match storage m = matches[matchId];

        require(m.status == MatchStatus.ACTIVE, "Match not active");
        require(
            _winner == m.player1 || _winner == m.player2,
            "Winner must be a player"
        );

        m.status = MatchStatus.RESOLVED;
        m.winner = _winner;

        uint256 payout = m.betAmount * 2;

        (bool success, ) = _winner.call{value: payout}("");
        require(success, "Payout failed");

        emit MatchResolved(matchId, _winner, payout);
    }

    // ---------------- VIEW ----------------

    function getMatch(uint256 matchId)
        external
        view
        returns (
            address player1,
            address player2,
            uint256 betAmount,
            bool player1Paid,
            bool player2Paid,
            MatchStatus status,
            address winner
        )
    {
        Match memory m = matches[matchId];
        return (
            m.player1,
            m.player2,
            m.betAmount,
            m.player1Paid,
            m.player2Paid,
            m.status,
            m.winner
        );
    }
}
