// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title PaymentGateway
 * @notice Non-custodial, low-fee Web3 payment gateway.
 *         Splits every payment atomically: 99% to the merchant,
 *         1% platform commission to the platform owner.
 *
 * @dev - Supports native coin (ETH/MATIC) and any ERC20 (USDC, WBTC, etc.).
 *      - The contract NEVER holds funds. Every payment is forwarded in the
 *        same transaction, so there is nothing to "withdraw" and no custody.
 *      - Reentrancy protected. Uses OpenZeppelin standards.
 *
 * IMPORTANT: There is no such thing as "native Bitcoin" in an EVM contract.
 *            For BTC payments, use WBTC (an ERC20) via payWithToken().
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract PaymentGateway is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // ----------------------------------------------------------------
    //  State
    // ----------------------------------------------------------------

    /// @notice Wallet that receives the platform commission (your cold wallet).
    address public platformOwner;

    /// @notice Commission in basis points. 100 = 1%. Max enforced at 10% (1000).
    uint256 public commissionRate;

    /// @notice Basis-point denominator. 10000 bps = 100%.
    uint256 public constant BPS_DENOMINATOR = 10000;

    /// @notice Hard ceiling on commission to protect merchants (10%).
    uint256 public constant MAX_COMMISSION_BPS = 1000;

    // ----------------------------------------------------------------
    //  Events
    // ----------------------------------------------------------------

    event NativePayment(
        address indexed payer,
        address indexed merchant,
        uint256 totalAmount,
        uint256 merchantAmount,
        uint256 commissionAmount,
        string orderId
    );

    event TokenPayment(
        address indexed payer,
        address indexed merchant,
        address indexed token,
        uint256 totalAmount,
        uint256 merchantAmount,
        uint256 commissionAmount,
        string orderId
    );

    event PlatformOwnerUpdated(address indexed oldOwner, address indexed newOwner);
    event CommissionRateUpdated(uint256 oldRate, uint256 newRate);

    // ----------------------------------------------------------------
    //  Constructor
    // ----------------------------------------------------------------

    /**
     * @param _platformOwner  Your commission-receiving cold wallet address.
     * @param _commissionRate Commission in bps (100 = 1%).
     *
     * @dev Pass your REAL cold wallet at deploy time. Never hard-code it.
     */
    constructor(address _platformOwner, uint256 _commissionRate)
        Ownable(msg.sender)
    {
        require(_platformOwner != address(0), "Owner cannot be zero address");
        require(_commissionRate <= MAX_COMMISSION_BPS, "Commission too high");

        platformOwner = _platformOwner;
        commissionRate = _commissionRate;
    }

    // ----------------------------------------------------------------
    //  Payment: Native coin (ETH / MATIC)
    // ----------------------------------------------------------------

    /**
     * @notice Pay a merchant in the native coin. Splits 99% / 1% atomically.
     * @param merchant The seller's address (receives 99%).
     * @param orderId  Off-chain order reference for reconciliation.
     *
     * @dev The full amount arrives via msg.value and is immediately forwarded.
     *      The contract keeps a zero balance after every call.
     */
    function payWithNative(address merchant, string calldata orderId)
        external
        payable
        nonReentrant
    {
        require(merchant != address(0), "Merchant cannot be zero address");
        require(msg.value > 0, "Amount must be greater than zero");

        uint256 commissionAmount = (msg.value * commissionRate) / BPS_DENOMINATOR;
        uint256 merchantAmount = msg.value - commissionAmount;

        // Forward merchant share.
        (bool merchantSent, ) = payable(merchant).call{value: merchantAmount}("");
        require(merchantSent, "Merchant transfer failed");

        // Forward commission (skip external call if it rounds to zero).
        if (commissionAmount > 0) {
            (bool ownerSent, ) = payable(platformOwner).call{value: commissionAmount}("");
            require(ownerSent, "Commission transfer failed");
        }

        emit NativePayment(
            msg.sender,
            merchant,
            msg.value,
            merchantAmount,
            commissionAmount,
            orderId
        );
    }

    // ----------------------------------------------------------------
    //  Payment: ERC20 (USDC, WBTC, etc.)
    // ----------------------------------------------------------------

    /**
     * @notice Pay a merchant in an ERC20 token. Splits 99% / 1% atomically.
     * @param token    ERC20 token address (e.g. USDC or WBTC).
     * @param merchant The seller's address (receives 99%).
     * @param amount   Total amount in the token's smallest unit.
     * @param orderId  Off-chain order reference for reconciliation.
     *
     * @dev Caller MUST approve() this contract for `amount` first.
     *      Uses SafeERC20 to support non-standard tokens like USDT.
     *      Funds move directly payer -> merchant and payer -> owner;
     *      the contract never holds a token balance.
     */
    function payWithToken(
        address token,
        address merchant,
        uint256 amount,
        string calldata orderId
    ) external nonReentrant {
        require(token != address(0), "Token cannot be zero address");
        require(merchant != address(0), "Merchant cannot be zero address");
        require(amount > 0, "Amount must be greater than zero");

        uint256 commissionAmount = (amount * commissionRate) / BPS_DENOMINATOR;
        uint256 merchantAmount = amount - commissionAmount;

        IERC20 erc20 = IERC20(token);

        // Pull merchant share directly from payer to merchant.
        erc20.safeTransferFrom(msg.sender, merchant, merchantAmount);

        // Pull commission directly from payer to platform owner.
        if (commissionAmount > 0) {
            erc20.safeTransferFrom(msg.sender, platformOwner, commissionAmount);
        }

        emit TokenPayment(
            msg.sender,
            merchant,
            token,
            amount,
            merchantAmount,
            commissionAmount,
            orderId
        );
    }

    // ----------------------------------------------------------------
    //  Admin
    // ----------------------------------------------------------------

    /// @notice Update the commission-receiving wallet.
    function setPlatformOwner(address _platformOwner) external onlyOwner {
        require(_platformOwner != address(0), "Owner cannot be zero address");
        emit PlatformOwnerUpdated(platformOwner, _platformOwner);
        platformOwner = _platformOwner;
    }

    /// @notice Update the commission rate (bps). Capped at MAX_COMMISSION_BPS.
    function setCommissionRate(uint256 _commissionRate) external onlyOwner {
        require(_commissionRate <= MAX_COMMISSION_BPS, "Commission too high");
        emit CommissionRateUpdated(commissionRate, _commissionRate);
        commissionRate = _commissionRate;
    }

    // ----------------------------------------------------------------
    //  Safety: recover funds accidentally sent to the contract
    // ----------------------------------------------------------------

    /**
     * @notice Rescue tokens someone sent directly to the contract by mistake.
     * @dev Normal payments never leave a balance here; this is a safety net.
     */
    function rescueToken(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }

    /// @notice Rescue native coin accidentally forced into the contract.
    function rescueNative() external onlyOwner {
        (bool sent, ) = payable(owner()).call{value: address(this).balance}("");
        require(sent, "Rescue failed");
    }
}
