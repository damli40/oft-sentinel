// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test helper: a contract that rejects all incoming MNT, used to prove the
///         AlertBus nudge is best-effort and never blocks the alert.
contract Rejector {
    receive() external payable {
        revert("no thanks");
    }
}
