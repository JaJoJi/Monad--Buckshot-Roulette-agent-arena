// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ArenaMatchEscrow} from "./ArenaMatchEscrow.sol";

contract ArenaMatchEscrowTest is Test {
    ArenaMatchEscrow escrow;

    address owner = address(0xA11CE);
    address player1 = address(0xBEEF);
    address player2 = address(0xCAFE);
    address outsider = address(0xDEAD);

    uint256 constant BET = 1 ether;

    function setUp() public {
        vm.deal(owner, 10 ether);
        vm.deal(player1, 10 ether);
        vm.deal(player2, 10 ether);
        vm.deal(outsider, 10 ether);

        vm.prank(owner);
        escrow = new ArenaMatchEscrow();
    }

    // ---------------- CREATE MATCH ----------------

    function test_CreateMatch() public {
        vm.prank(owner);
        uint256 matchId = escrow.createMatch(player1, player2, BET);

        (
            address p1,
            address p2,
            uint256 betAmount,
            bool p1Paid,
            bool p2Paid,
            ArenaMatchEscrow.MatchStatus status,
            address winner
        ) = escrow.getMatch(matchId);

        assertEq(p1, player1);
        assertEq(p2, player2);
        assertEq(betAmount, BET);
        assertFalse(p1Paid);
        assertFalse(p2Paid);
        assertEq(uint256(status), uint256(ArenaMatchEscrow.MatchStatus.CREATED));
        assertEq(winner, address(0));
    }

    function test_CreateMatch_NotOwner_Revert() public {
        vm.prank(player1);
        vm.expectRevert("Not server");
        escrow.createMatch(player1, player2, BET);
    }

    // ---------------- JOIN MATCH ----------------

    function test_JoinMatch_Player1AndPlayer2() public {
        vm.prank(owner);
        uint256 matchId = escrow.createMatch(player1, player2, BET);

        vm.prank(player1);
        escrow.joinMatch{value: BET}(matchId);

        vm.prank(player2);
        escrow.joinMatch{value: BET}(matchId);

        (, , , bool p1Paid, bool p2Paid, ArenaMatchEscrow.MatchStatus status, ) =
            escrow.getMatch(matchId);

        assertTrue(p1Paid);
        assertTrue(p2Paid);
        assertEq(uint256(status), uint256(ArenaMatchEscrow.MatchStatus.ACTIVE));
    }

    function test_JoinMatch_WrongAmount_Revert() public {
        vm.prank(owner);
        uint256 matchId = escrow.createMatch(player1, player2, BET);

        vm.prank(player1);
        vm.expectRevert("Incorrect bet amount");
        escrow.joinMatch{value: 0.5 ether}(matchId);
    }

    function test_JoinMatch_NotPlayer_Revert() public {
        vm.prank(owner);
        uint256 matchId = escrow.createMatch(player1, player2, BET);

        vm.prank(outsider);
        vm.expectRevert("Not a player");
        escrow.joinMatch{value: BET}(matchId);
    }

    // ---------------- RESOLVE MATCH ----------------

    function test_ResolveMatch_PayoutToWinner() public {
        vm.prank(owner);
        uint256 matchId = escrow.createMatch(player1, player2, BET);

        vm.prank(player1);
        escrow.joinMatch{value: BET}(matchId);

        vm.prank(player2);
        escrow.joinMatch{value: BET}(matchId);

        uint256 balanceBefore = player1.balance;

        vm.prank(owner);
        escrow.resolveMatch(matchId, player1);

        uint256 balanceAfter = player1.balance;

        assertEq(balanceAfter - balanceBefore, BET * 2);

        (, , , , , ArenaMatchEscrow.MatchStatus status, address winner) =
            escrow.getMatch(matchId);

        assertEq(uint256(status), uint256(ArenaMatchEscrow.MatchStatus.RESOLVED));
        assertEq(winner, player1);
    }

    function test_ResolveMatch_NotOwner_Revert() public {
        vm.prank(owner);
        uint256 matchId = escrow.createMatch(player1, player2, BET);

        vm.prank(player1);
        escrow.joinMatch{value: BET}(matchId);

        vm.prank(player2);
        escrow.joinMatch{value: BET}(matchId);

        vm.prank(player1);
        vm.expectRevert("Not server");
        escrow.resolveMatch(matchId, player1);
    }

    function test_ResolveMatch_InvalidWinner_Revert() public {
        vm.prank(owner);
        uint256 matchId = escrow.createMatch(player1, player2, BET);

        vm.prank(player1);
        escrow.joinMatch{value: BET}(matchId);

        vm.prank(player2);
        escrow.joinMatch{value: BET}(matchId);

        vm.prank(owner);
        vm.expectRevert("Winner must be a player");
        escrow.resolveMatch(matchId, outsider);
    }
}
